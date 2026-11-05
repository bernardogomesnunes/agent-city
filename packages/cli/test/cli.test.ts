import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { FakeProvider, ProviderUnreachableError, type ChatResponse } from "@agentcity/core";
import { ActionLog, BoardStore, loadGlobalConfig, loadProjectConfig, openDb, projectDirs } from "@agentcity/safety";
import { MemoryStore } from "@agentcity/org";
import { runCli, type CliDeps } from "../src/wire.js";
import { readSecrets } from "../src/secrets.js";
import { hqAllowed } from "../src/hq.js";

let home: string;
let input: PassThrough;
let out: string;
let err: string;
let interrupt: (() => void | Promise<void>) | undefined;
let exitCodes: number[];

const usage = { inputTokens: 1, outputTokens: 1 };
const call = (id: string, name: string, args: unknown): ChatResponse => ({ text: "", toolCalls: [{ id, name, args }], usage });
const done: ChatResponse = { text: "finished", toolCalls: [], usage };

function deps(provider?: FakeProvider): CliDeps {
  const o = new PassThrough();
  const e = new PassThrough();
  o.on("data", (d: Buffer) => (out += d.toString()));
  e.on("data", (d: Buffer) => (err += d.toString()));
  return {
    home,
    io: { input, output: o, error: e },
    providerOverride: provider,
    registerInterrupt: (h) => {
      interrupt = h;
      return () => undefined;
    },
    exit: (c) => void exitCodes.push(c),
  };
}
const cli = (args: string[], provider?: FakeProvider) => runCli(args, deps(provider));
const actions = (project = "demo") => {
  const db = openDb(home);
  try {
    return new ActionLog(db, []).list(project);
  } finally {
    db.close();
  }
};
const outboxFiles = () => fs.readdirSync(projectDirs(home, "demo").outbox);

async function setupAgent() {
  expect(await cli(["init", "demo"])).toBe(0);
  expect(await cli(["agent", "create", "ada", "--name", "Ada", "--role", "worker", "--model", "lmstudio/test", "--persona", "You are Ada."])).toBe(0);
  expect(await cli(["grant", "demo", "ada"])).toBe(0);
  fs.writeFileSync(path.join(projectDirs(home, "demo").sandbox, "in.txt"), "hello");
}

const fullScript = () =>
  new FakeProvider([
    call("1", "read_file", { path: "in.txt" }),
    call("2", "write_file", { path: "out.txt", content: "x" }),
    call("3", "send_message", { to: "bob", body: "hi" }),
    done,
  ]);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cli-"));
  input = new PassThrough();
  out = "";
  err = "";
  interrupt = undefined;
  exitCodes = [];
});

describe("project and agent commands", () => {
  it("init creates project.json, sandbox and outbox", async () => {
    expect(await cli(["init", "demo"])).toBe(0);
    const d = projectDirs(home, "demo");
    expect(fs.existsSync(d.config)).toBe(true);
    expect(fs.statSync(d.sandbox).isDirectory()).toBe(true);
    expect(fs.statSync(d.outbox).isDirectory()).toBe(true);
    const c = loadProjectConfig(home, "demo");
    expect(c.ok && c.config.agents).toEqual([]);
    expect(await cli(["init", "demo"])).toBe(1);
  });

  it("project remove deletes config and keeps the folder", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cli-linked-"));
    try {
      fs.writeFileSync(path.join(folder, "keep.txt"), "mine");
      await cli(["init", "demo"]);
      expect(await cli(["project", "link", "demo", folder])).toBe(0);
      const db = openDb(home);
      const board = new BoardStore(db);
      board.createGoal("demo", "a goal");
      board.createGoal("site", "other");
      db.close();
      expect(await cli(["project", "remove", "demo", "--port", "1"])).toBe(0);
      expect(out).toContain("Removed project demo");
      expect(fs.existsSync(projectDirs(home, "demo").root)).toBe(false);
      expect(fs.readFileSync(path.join(folder, "keep.txt"), "utf8")).toBe("mine");
      expect(await cli(["project", "show", "demo"])).toBe(1);
      const after = openDb(home);
      expect(new BoardStore(after).goals("demo")).toEqual([]);
      expect(new BoardStore(after).goals("site")).toHaveLength(1);
      after.close();
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("project remove refuses while a city answers", async () => {
    await cli(["init", "demo"]);
    const srv = http.createServer((_q, res) => res.writeHead(200, { "x-agent-city": "1" }).end());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as { port: number }).port;
      expect(await cli(["project", "remove", "demo", "--port", String(port)])).toBe(1);
      expect(err).toContain("the city is running; delete the project from the city");
      expect(fs.existsSync(projectDirs(home, "demo").config)).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("project remove refuses while the home's city lock names a live process, on any port", async () => {
    await cli(["init", "demo"]);
    fs.writeFileSync(path.join(home, "city.lock"), JSON.stringify({ pid: process.pid, port: 5999 }));
    expect(await cli(["project", "remove", "demo", "--port", "1"])).toBe(1);
    expect(err).toContain("the city is running; delete the project from the city");
    expect(err).toContain(`if no city runs, delete ${path.join(home, "city.lock")}`);
    expect(fs.existsSync(projectDirs(home, "demo").config)).toBe(true);
  });

  it("project remove ignores a city lock whose process is dead", async () => {
    await cli(["init", "demo"]);
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    fs.writeFileSync(path.join(home, "city.lock"), JSON.stringify({ pid: dead.pid, port: 5999 }));
    expect(await cli(["project", "remove", "demo", "--port", "1"])).toBe(0);
    expect(fs.existsSync(projectDirs(home, "demo").root)).toBe(false);
  });

  it("project remove unknown fails", async () => {
    expect(await cli(["project", "remove", "nope", "--port", "1"])).toBe(1);
    expect(err).toContain("No project nope");
  });

  it("agent remove deletes the agent and takes it off every project team", async () => {
    await cli(["init", "demo"]);
    await cli(["init", "site"]);
    await cli(["agent", "create", "ada", "--name", "Ada", "--persona", "You are Ada."]);
    await cli(["agent", "create", "bob", "--name", "Bob", "--persona", "You are Bob."]);
    for (const [p, a] of [["demo", "ada"], ["demo", "bob"], ["site", "ada"]]) await cli(["grant", p, a]);
    expect(await cli(["agent", "remove", "ada"])).toBe(0);
    expect(out).toContain("Removed agent ada");
    const team = (p: string) => { const c = loadProjectConfig(home, p); return c.ok ? c.config.agents : []; };
    expect(team("demo")).toEqual(["bob"]);
    expect(team("site")).toEqual([]);
    expect(fs.existsSync(path.join(home, "agents", "ada"))).toBe(false);
    expect(await cli(["agent", "remove", "ada"])).toBe(1);
  });

  it("agent create then show prints the persona and version 1", async () => {
    await cli(["agent", "create", "ada", "--name", "Ada", "--persona", "You are Ada."]);
    expect(await cli(["agent", "show", "ada"])).toBe(0);
    expect(out).toContain("You are Ada.");
    expect(out).toContain("version: 1");
  });

  it("agent edit --persona bumps to version 2 and show --version 1 keeps the old one", async () => {
    await cli(["agent", "create", "ada", "--name", "Ada", "--persona", "old"]);
    expect(await cli(["agent", "edit", "ada", "--persona", "new"])).toBe(0);
    expect(out).toContain("version 2");
    out = "";
    await cli(["agent", "show", "ada", "--version", "1"]);
    expect(out).toContain("old");
    expect(await cli(["agent", "show", "ada", "--version", "9"])).toBe(1);
    out = "";
    await cli(["agent", "list"]);
    expect(out).toContain("ada");
  });

  it("agent --building sets, shows and rejects bad values", async () => {
    expect(await cli(["agent", "create", "x", "--name", "X", "--persona", "p", "--building", "visual"])).toBe(0);
    await cli(["agent", "show", "x"]);
    expect(out).toContain("building: visual");
    out = "";
    await cli(["agent", "list"]);
    expect(out).toBe("x\tX\tworker\tclaude-haiku-5-5\tv1\tvisual\n");
    expect(await cli(["agent", "edit", "x", "--building", "software"])).toBe(0);
    expect(out).toContain("version 2");
    expect(await cli(["agent", "create", "y", "--name", "Y", "--persona", "p", "--building", "castle"])).toBe(1);
  });

  it("agent create rejects an unknown model id", async () => {
    expect(await cli(["agent", "create", "ada", "--name", "Ada", "--persona", "p", "--model", "gpt-4o"])).toBe(1);
    expect(err).toContain("unknown model gpt-4o");
  });

  it("agent edit --model claude-sub/haiku saves version 2", async () => {
    await cli(["agent", "create", "ada", "--name", "Ada", "--persona", "p"]);
    expect(await cli(["agent", "edit", "ada", "--model", "claude-sub/haiku"])).toBe(0);
    out = "";
    await cli(["agent", "list"]);
    expect(out).toBe("ada\tAda\tworker\tclaude-sub/haiku\tv2\tsoftware\n");
    expect(await cli(["agent", "edit", "ada", "--model", "api/nope/x"])).toBe(1);
    expect(err).toContain("No connection nope");
  });

  it("agent create reads --persona-file and rejects a missing persona", async () => {
    const f = path.join(home, "p.txt");
    fs.writeFileSync(f, "From file.");
    expect(await cli(["agent", "create", "bo", "--name", "Bo", "--persona-file", f])).toBe(0);
    await cli(["agent", "show", "bo"]);
    expect(out).toContain("From file.");
    expect(await cli(["agent", "create", "cy", "--name", "Cy"])).toBe(1);
  });

  it("grant adds the agent to project agents, revoke removes it", async () => {
    await cli(["init", "demo"]);
    await cli(["agent", "create", "ada", "--name", "Ada", "--persona", "p"]);
    await cli(["grant", "demo", "ada"]);
    let c = loadProjectConfig(home, "demo");
    expect(c.ok && c.config.agents).toEqual(["ada"]);
    await cli(["revoke", "demo", "ada"]);
    c = loadProjectConfig(home, "demo");
    expect(c.ok && c.config.agents).toEqual([]);
    expect(await cli(["grant", "demo", "ghost"])).toBe(1);
  });
});

describe("run", () => {
  it("run with an ungranted agent stops with agent_not_allowed", async () => {
    await cli(["init", "demo"]);
    await cli(["agent", "create", "ada", "--name", "Ada", "--model", "lmstudio/test", "--persona", "p"]);
    const code = await cli(["run", "demo", "--agent", "ada", "go"], new FakeProvider([done]));
    expect(code).toBe(1);
    expect(err).toContain("agent_not_allowed");
    expect(actions().some((a) => a.type === "run.stopped" && (a.payload as { reason: string }).reason === "agent_not_allowed")).toBe(true);
  });

  it("run sends the persona as the start of the system prompt", async () => {
    await setupAgent();
    const p = new FakeProvider([done]);
    expect(await cli(["run", "demo", "--agent", "ada", "go"], p)).toBe(0);
    const first = p.requests[0].messages[0];
    expect(first.role).toBe("system");
    expect(first.content.startsWith("You are Ada.")).toBe(true);
    expect(p.requests[0].model).toBe("lmstudio/test");
  });

  it("run with a missing agent exits 1 with the hint", async () => {
    await cli(["init", "demo"]);
    expect(await cli(["run", "demo", "--agent", "nobody", "go"], new FakeProvider([]))).toBe(1);
    expect(err).toContain("No agent nobody. Run: agentcity agent create nobody ...");
  });

  it("run executes read, write, send with approval y", async () => {
    await setupAgent();
    input.write("y\n");
    expect(await cli(["run", "demo", "--agent", "ada", "go"], fullScript())).toBe(0);
    expect(outboxFiles()).toHaveLength(1);
    expect(fs.readFileSync(path.join(projectDirs(home, "demo").sandbox, "out.txt"), "utf8")).toBe("x");
    expect(out).toMatch(/\[\d\d:\d\d:\d\d\] run\.started Ada v1/);
    expect(out).toMatch(/Ada wants to run send_message/);
  });

  it("run with approval n leaves outbox empty", async () => {
    await setupAgent();
    input.write("n\n");
    expect(await cli(["run", "demo", "--agent", "ada", "go"], fullScript())).toBe(0);
    expect(outboxFiles()).toHaveLength(0);
  });

  it("--model overrides the profile model", async () => {
    await setupAgent();
    const p = new FakeProvider([done]);
    await cli(["run", "demo", "--agent", "ada", "go", "--model", "lmstudio/other"], p);
    expect(p.requests[0].model).toBe("lmstudio/other");
  });

  it("kill then run stops with killed and unkill restores", async () => {
    await setupAgent();
    await cli(["kill", "demo"]);
    expect(await cli(["run", "demo", "--agent", "ada", "go"], new FakeProvider([done]))).toBe(1);
    expect(err).toContain("killed");
    await cli(["unkill", "demo"]);
    expect(await cli(["run", "demo", "--agent", "ada", "go"], new FakeProvider([done]))).toBe(0);
  });

  it("log prints every action type of a run", async () => {
    await setupAgent();
    await cli(["run", "demo", "--agent", "ada", "go"], new FakeProvider([call("1", "read_file", { path: "in.txt" }), done]));
    out = "";
    expect(await cli(["log", "demo"])).toBe(0);
    for (const t of ["run.started", "gate.decision", "tool.result", "run.stopped", "usage"]) expect(out).toContain(t);
  });

  it("run without anthropic key exits 1 with the hint", async () => {
    await cli(["init", "demo"]);
    await cli(["agent", "create", "ada", "--name", "Ada", "--persona", "p"]);
    await cli(["grant", "demo", "ada"]);
    expect(await cli(["run", "demo", "--agent", "ada", "go"])).toBe(1);
    expect(err).toContain("No Anthropic key. Run: agentcity secrets set anthropic");
  });

  it("an unreachable LM Studio prints the base URL", async () => {
    await setupAgent();
    const u = () => new ProviderUnreachableError("http://localhost:1234/v1");
    // The loop retries after 1s and 4s, so this test takes about 5s.
    expect(await cli(["run", "demo", "--agent", "ada", "go"], new FakeProvider([u(), u(), u()]))).toBe(1);
    expect(err).toContain("Cannot reach LM Studio at http://localhost:1234/v1. Is it running?");
  }, 15000);

  it("a provider error prints its message", async () => {
    await setupAgent();
    const e = () => new Error("Claude subscription not ready: claude is not installed. Open HQ, Configure, APIs and click Install.");
    expect(await cli(["run", "demo", "--agent", "ada", "go"], new FakeProvider([e(), e(), e()]))).toBe(1);
    expect(err).toContain("Run stopped: provider_error: Claude subscription not ready: claude is not installed.");
  }, 15000);

  it("logged payloads replace a stored secret with [secret]", async () => {
    await setupAgent();
    fs.writeFileSync(path.join(home, "secrets.json"), JSON.stringify({ anthropic: "sk-secret-value-1" }));
    await cli(["run", "demo", "--agent", "ada", "sk-secret-value-1"], new FakeProvider([done]));
    const text = JSON.stringify(actions());
    expect(text).not.toContain("sk-secret-value-1");
    expect(text).toContain("[secret]");
    expect(out).not.toContain("sk-secret-value-1");
    expect(out).toContain("[secret]");
  });

  it("interrupt during approval denies pending and logs interrupted", async () => {
    await setupAgent();
    const run = cli(["run", "demo", "--agent", "ada", "go"], new FakeProvider([call("1", "send_message", { to: "b", body: "x" }), done]));
    for (let i = 0; i < 200 && !out.includes("Approve?"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(out).toContain("Approve?");
    await interrupt!();
    expect(await run).toBe(130);
    expect(exitCodes).toEqual([130]);
    const stops = actions().filter((a) => a.type === "run.stopped");
    expect(stops.map((s) => (s.payload as { reason: string }).reason)).toEqual(["interrupted"]);
    const db = openDb(home);
    const rows = db.prepare("SELECT status, decided_by FROM approvals").all();
    db.close();
    expect(rows).toEqual([{ status: "denied", decided_by: "shutdown" }]);
    expect(outboxFiles()).toHaveLength(0);
  });
});

describe("interrupt mid-turn", () => {
  it("interrupt during the first of two send_message calls leaves 0 pending rows and an empty outbox", async () => {
    await setupAgent();
    const two: ChatResponse = {
      text: "",
      toolCalls: [
        { id: "1", name: "send_message", args: { to: "b", body: "x" } },
        { id: "2", name: "send_message", args: { to: "c", body: "y" } },
      ],
      usage,
    };
    const run = cli(["run", "demo", "--agent", "ada", "go"], new FakeProvider([two, done]));
    for (let i = 0; i < 200 && !out.includes("Approve?"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(out).toContain("Approve?");
    await interrupt!();
    expect(await run).toBe(130);
    const db = openDb(home);
    const pending = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number };
    db.close();
    expect(pending.n).toBe(0);
    expect(outboxFiles()).toHaveLength(0);
  });
});

describe("secrets set", () => {
  it("stores the key without echoing it", async () => {
    input.write("sk-hidden-key-99\n");
    expect(await cli(["secrets", "set", "anthropic"])).toBe(0);
    expect(out).not.toContain("sk-hidden-key-99");
    expect(JSON.parse(fs.readFileSync(path.join(home, "secrets.json"), "utf8"))).toEqual({ anthropic: "sk-hidden-key-99" });
  });
});

describe("connection", () => {
  it("add, list, remove, and list never prints the key", async () => {
    expect(await cli(["connection", "list"])).toBe(0);
    expect(out).toBe("No connections.\n");
    expect(await cli(["connection", "add", "groq", "https://api.groq.com/openai/v1", "--input-price", "0.59", "--output-price", "0.79"])).toBe(0);
    out = "";
    await cli(["connection", "list"]);
    expect(out).toBe("groq\thttps://api.groq.com/openai/v1\t$0.59/$0.79 per MTok\tno key\n");
    input.write("k-secret-123\n");
    await cli(["secrets", "set", "api-groq"]);
    out = "";
    await cli(["connection", "list"]);
    expect(out).toContain("key set");
    expect(out).not.toContain("k-secret-123");
    expect(await cli(["connection", "add", "free", "http://localhost:11434/v1"])).toBe(0);
    out = "";
    await cli(["connection", "list"]);
    expect(out).toContain("free\thttp://localhost:11434/v1\tno price\tno key");
    expect(await cli(["connection", "remove", "groq"])).toBe(0);
    expect(await cli(["connection", "remove", "free"])).toBe(0);
    out = "";
    await cli(["connection", "list"]);
    expect(out).toBe("No connections.\n");
    expect(await cli(["connection", "remove", "free"])).toBe(1);
    expect(err).toContain("No connection free");
  });

  it("add rejects one price alone, a bad name, a file: URL and a duplicate", async () => {
    expect(await cli(["connection", "add", "groq", "https://g/v1", "--input-price", "1"])).toBe(1);
    expect(err).toContain("Give both --input-price and --output-price, or neither.");
    expect(await cli(["connection", "add", "Bad Name", "https://g/v1"])).toBe(1);
    expect(await cli(["connection", "add", "x", "file:///etc"])).toBe(1);
    expect(await cli(["connection", "add", "groq", "https://g/v1"])).toBe(0);
    expect(await cli(["connection", "add", "groq", "https://h/v1"])).toBe(1);
    expect(err).toContain("Connection groq already exists.");
  });

  it("remove deletes the connection's key, so a re-added name starts with no key", async () => {
    await cli(["connection", "add", "groq", "https://g/v1"]);
    input.write("k-old-1\n");
    await cli(["secrets", "set", "api-groq"]);
    expect(await cli(["connection", "remove", "groq"])).toBe(0);
    expect(readSecrets(home)).not.toHaveProperty("api-groq");
  });

  it("a run on a removed connection stops with the message", async () => {
    await cli(["init", "demo"]);
    await cli(["connection", "add", "gone", "https://g/v1", "--input-price", "1", "--output-price", "1"]);
    await cli(["agent", "create", "ada", "--name", "Ada", "--persona", "p", "--model", "api/gone/m"]);
    await cli(["grant", "demo", "ada"]);
    expect(await cli(["connection", "remove", "gone"])).toBe(0);
    err = "";
    expect(await cli(["run", "demo", "--agent", "ada", "go"])).toBe(1);
    expect(err).toContain("No connection gone");
  });
});

describe("agent memory", () => {
  const notesFile = () => path.join(home, "agents", "ada", "memory", "notes.md");

  it("agent memory prints notes", async () => {
    await setupAgent();
    out = "";
    err = "";
    new MemoryStore(home).append("ada", "likes tea");
    new MemoryStore(home).append("ada", "avoids mondays");
    expect(await cli(["agent", "memory", "ada"])).toBe(0);
    expect(out).toBe("likes tea\navoids mondays\n");
  });

  it("agent memory on empty notes prints No notes.", async () => {
    await setupAgent();
    out = "";
    err = "";
    expect(await cli(["agent", "memory", "ada"])).toBe(0);
    expect(out).toBe("No notes.\n");
    expect(await cli(["agent", "memory", "ghost"])).toBe(1);
    expect(err).toContain("No agent ghost.");
  });

  it("agent memory --clear with y empties, with n keeps", async () => {
    await setupAgent();
    out = "";
    err = "";
    new MemoryStore(home).append("ada", "likes tea");
    input.write("n\n");
    expect(await cli(["agent", "memory", "ada", "--clear"])).toBe(0);
    expect(out).toBe("Clear notes for ada? [y/N] Kept.\n");
    expect(fs.readFileSync(notesFile(), "utf8")).toBe("likes tea");
    out = "";
    input.write("y\n");
    expect(await cli(["agent", "memory", "ada", "--clear"])).toBe(0);
    expect(out).toBe("Clear notes for ada? [y/N] Cleared.\n");
    expect(fs.readFileSync(notesFile(), "utf8")).toBe("");
  });
});

describe("log --tree", () => {
  it("log --tree indents mgr under boss and ada under mgr", async () => {
    await cli(["init", "demo"]);
    out = "";
    const db = openDb(home);
    const log = new ActionLog(db, []);
    const row = (agentId: string, runId?: string, parentRunId?: string) =>
      log.append({ projectId: "demo", agentId, type: "usage", payload: { n: 1 }, runId, parentRunId });
    row("old");
    row("boss", "r1");
    row("mgr", "r2", "r1");
    row("ada", "r3", "r2");
    row("boss", "r1");
    db.close();
    expect(await cli(["log", "demo", "--tree"])).toBe(0);
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\d+\t\S+\told\tusage/);
    expect(lines.filter((l) => /^\s*run /.test(l))).toEqual(["run r1 boss", "  run r2 mgr", "    run r3 ada"]);
    expect(lines.filter((l) => /^ {2}\d/.test(l))).toHaveLength(2);
    expect(lines.filter((l) => /^ {4}\d/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /^ {6}\d/.test(l))).toHaveLength(1);
    expect(lines.indexOf("run r1 boss")).toBe(1);
    expect(lines.slice(2, 4).every((l) => /^ {2}\d+\t\S+\tboss/.test(l))).toBe(true);
    expect(await cli(["log", "demo", "--tree", "--tail"])).toBe(1);
  });
});

describe("lmstudio url and API base URLs", () => {
  it("lmstudio url saves the base with /v1 and keeps it in HQ's allowed commands", async () => {
    expect(hqAllowed(["lmstudio", "url", "http://127.0.0.1:1234"])).toBe(true);
    expect(await cli(["lmstudio", "url", "http://127.0.0.1:1234/"])).toBe(0);
    expect(loadGlobalConfig(home).lmStudioBaseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("lmstudio url rejects a URL that is not http or https", async () => {
    expect(await cli(["lmstudio", "url", "ftp://127.0.0.1:1234"])).toBe(1);
    expect(err).toContain("http or https");
  });

  it("connection add saves a bare base with /v1", async () => {
    expect(await cli(["connection", "add", "lm-studio", "http://127.0.0.1:1234"])).toBe(0);
    expect(loadGlobalConfig(home).connections[0]!.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });
});
