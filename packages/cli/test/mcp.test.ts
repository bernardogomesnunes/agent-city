import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { FakeProvider, type ChatResponse } from "@agentcity/core";
import { loadGlobalConfig, loadProjectConfig, toolAllowed, type ApprovalStatus, type McpServer } from "@agentcity/safety";
import { runCli, type CliDeps } from "../src/wire.js";
import { McpHub, fillSecrets, literalSecrets, mcpToolName, resultText, MCP_OUTPUT_CHARS } from "../src/mcp.js";
import { setSecret } from "../src/secrets.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp.mjs");
const usage = { inputTokens: 1, outputTokens: 1 };
const call = (id: string, name: string, args: unknown): ChatResponse => ({ text: "", toolCalls: [{ id, name, args }], usage });
const done: ChatResponse = { text: "finished", toolCalls: [], usage };

let home: string;
let out: string;
let err: string;
let asked: string[];
let answer: ApprovalStatus;

function deps(provider?: FakeProvider): CliDeps {
  const o = new PassThrough();
  const e = new PassThrough();
  o.on("data", (d: Buffer) => (out += d.toString()));
  e.on("data", (d: Buffer) => (err += d.toString()));
  return {
    home,
    io: { input: new PassThrough(), output: o, error: e },
    providerOverride: provider,
    registerInterrupt: () => () => undefined,
    exit: () => undefined,
    approverFactory: () => ({
      decide: async (req) => {
        asked.push(req.tool);
        return answer;
      },
      cancel: () => undefined,
      close: () => undefined,
    }),
  };
}
const cli = (args: string[], provider?: FakeProvider) => runCli(args, deps(provider));
const fakeServer = (over: Partial<McpServer> = {}): McpServer =>
  ({ name: "fake", command: process.execPath, args: [FAKE], env: {}, headers: {}, allow: [], ...over }) as McpServer;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mcp-"));
  out = "";
  err = "";
  asked = [];
  answer = "approved";
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("mcp helpers", () => {
  it("names tools mcp__server__tool, safe for models, at most 64 characters", () => {
    expect(mcpToolName("gmail", "send.email")).toBe("mcp__gmail__send_email");
    const long = mcpToolName("srv", "x".repeat(100));
    expect(long).toHaveLength(64);
    expect(long).not.toBe(mcpToolName("srv", "x".repeat(99)));
  });
  it("fills secret references and names a missing one", () => {
    expect(fillSecrets("Bearer secret:gh", { gh: "abc" }, "s")).toBe("Bearer abc");
    expect(() => fillSecrets("secret:nope", {}, "MCP server s")).toThrow("MCP server s needs secret nope. Run: agentcity secrets set nope");
  });
  it("flags literal keys in env and headers", () => {
    expect(literalSecrets({ env: { GITHUB_TOKEN: "ghp_x", MODE: "fast" }, headers: { Authorization: "Bearer secret:gh" } })).toEqual(["GITHUB_TOKEN"]);
  });
  it("turns content into text and cuts long output", () => {
    expect(resultText([{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }, { type: "resource", resource: { uri: "u" } }]))
      .toBe("a\n[image image/png]\n[resource u]");
    expect(resultText([{ type: "text", text: "x".repeat(MCP_OUTPUT_CHARS + 5) }])).toContain("[output cut");
  });
  it("matches wildcard allowlist entries", () => {
    expect(toolAllowed(["mcp__fake__*"], "mcp__fake__echo")).toBe(true);
    expect(toolAllowed(["mcp__fake__*"], "mcp__other__echo")).toBe(false);
    expect(toolAllowed(["read_file"], "read_file")).toBe(true);
  });
});

describe("McpHub", () => {
  it("lists and calls tools on a stdio server, with secrets in env only for that server", async () => {
    process.env.OTHER_SECRET = "leak";
    const warns: string[] = [];
    const hub = await McpHub.connect([fakeServer({ env: { FAKE_TOKEN: "secret:fake-key" }, allow: ["echo"] })], { "fake-key": "s3" }, (l) => warns.push(l));
    try {
      expect(warns).toEqual([]);
      expect(hub.tools.map((t) => [t.name, t.tier])).toEqual([["mcp__fake__echo", 1], ["mcp__fake__env", 2], ["mcp__fake__fail", 2]]);
      const ctx = { projectId: "p", agentId: "a", sandboxDir: home, outboxDir: home };
      const byName = new Map(hub.tools.map((t) => [t.name, t]));
      expect(await byName.get("mcp__fake__echo")!.run({ text: "hi" }, ctx)).toBe("echo: hi");
      expect(await byName.get("mcp__fake__env")!.run({}, ctx)).toBe("token=s3 path=set other=none");
      await expect(byName.get("mcp__fake__fail")!.run({}, ctx)).rejects.toThrow("it broke");
      expect(byName.get("mcp__fake__echo")!.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
    } finally {
      delete process.env.OTHER_SECRET;
      await hub.close();
    }
  });
  it("skips a server that cannot start and reports it", async () => {
    const warns: string[] = [];
    const hub = await McpHub.connect([fakeServer({ name: "bad", command: "no-such-binary-xyz", args: [] }), fakeServer()], {}, (l) => warns.push(l));
    try {
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/^MCP server bad skipped: /);
      expect(hub.tools.map((t) => t.name)).toContain("mcp__fake__echo");
    } finally {
      await hub.close();
    }
  });
  it("skips a server whose secret is missing", async () => {
    const warns: string[] = [];
    const hub = await McpHub.connect([fakeServer({ env: { FAKE_TOKEN: "secret:missing" } })], {}, (l) => warns.push(l));
    await hub.close();
    expect(warns).toEqual(["MCP server fake skipped: MCP server fake needs secret missing. Run: agentcity secrets set missing"]);
    expect(hub.tools).toEqual([]);
  });
});

describe("mcp commands and runs", () => {
  async function setup() {
    expect(await cli(["mcp", "add", "fake", "--env", "FAKE_TOKEN=secret:fake-key", "--", process.execPath, FAKE])).toBe(0);
    setSecret(home, "fake-key", "s3");
    expect(await cli(["init", "demo"])).toBe(0);
    expect(await cli(["agent", "create", "ada", "--name", "Ada", "--model", "lmstudio/test", "--persona", "You are Ada."])).toBe(0);
    expect(await cli(["grant", "demo", "ada"])).toBe(0);
  }

  it("add, list, tools, allow, grant and remove", async () => {
    await setup();
    expect(loadGlobalConfig(home).mcpServers).toEqual([
      expect.objectContaining({ name: "fake", command: process.execPath, args: [FAKE], env: { FAKE_TOKEN: "secret:fake-key" } }),
    ]);
    expect(await cli(["mcp", "add", "fake", "--url", "http://x"])).toBe(1);
    expect(await cli(["mcp", "add", "lit", "--env", "API_KEY=abc", "--", "x"])).toBe(1);
    expect(err).toContain("API_KEY looks like a key");
    expect(await cli(["mcp", "add", "both", "--url", "http://x", "--", "x"])).toBe(1);
    expect(await cli(["mcp", "allow", "fake", "echo"])).toBe(0);
    out = "";
    expect(await cli(["mcp", "tools", "fake"])).toBe(0);
    expect(out).toContain("mcp__fake__echo\truns");
    expect(out).toContain("mcp__fake__fail\tasks");
    expect(await cli(["mcp", "grant", "demo", "fake"])).toBe(0);
    const c = loadProjectConfig(home, "demo");
    expect(c.ok && c.config.allowedTools).toContain("mcp__fake__*");
    expect(await cli(["mcp", "grant", "demo", "nope"])).toBe(1);
    expect(await cli(["mcp", "remove", "fake"])).toBe(0);
    expect(loadGlobalConfig(home).mcpServers).toEqual([]);
  });

  it("an agent calls a granted server's tools; allowed tools run, others ask", async () => {
    await setup();
    expect(await cli(["mcp", "allow", "fake", "echo"])).toBe(0);
    expect(await cli(["mcp", "grant", "demo", "fake"])).toBe(0);
    answer = "denied";
    const p = new FakeProvider([call("1", "mcp__fake__echo", { text: "yo" }), call("2", "mcp__fake__env", {}), done]);
    expect(await cli(["run", "demo", "--agent", "ada", "go"], p)).toBe(0);
    expect(asked).toEqual(["mcp__fake__env"]);
    expect(out).toContain("tool.result mcp__fake__echo ok echo: yo");
    expect(out).toContain("tool.result mcp__fake__env denied");
    expect(p.requests[0]!.tools.map((t) => t.name)).toContain("mcp__fake__echo");
  });

  it("a project without the grant does not start the server or offer its tools", async () => {
    await setup();
    const p = new FakeProvider([call("1", "mcp__fake__echo", { text: "yo" }), done]);
    expect(await cli(["run", "demo", "--agent", "ada", "go"], p)).toBe(0);
    expect(p.requests[0]!.tools.map((t) => t.name)).not.toContain("mcp__fake__echo");
    expect(out).toContain("unknown tool mcp__fake__echo");
  });
});
