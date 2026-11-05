import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChatRequest, ChatResponse, Provider } from "@agentcity/core";
import { ActionLog, CityPlots, loadProjectConfig, openDb, projectDirs, saveProjectConfig } from "@agentcity/safety";
import { runCli, type CliDeps } from "../src/wire.js";
import type { ClosableApprover } from "../src/approver.js";

type Step = ChatResponse | Error | (() => ChatResponse);

/** Routes each request to the script of the agent whose persona starts the system prompt. */
class Router implements Provider {
  id = "router";
  requests: Array<{ who: string; req: ChatRequest }> = [];
  constructor(private scripts: Record<string, Step[]>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const sys = req.messages[0];
    const text = sys.role === "system" ? sys.content : "";
    const who = Object.keys(this.scripts).find((k) => text.startsWith(`You are ${k}.`));
    if (!who) throw new Error(`no script for prompt: ${text.slice(0, 40)}`);
    this.requests.push({ who, req });
    const next = this.scripts[who].shift();
    if (next === undefined) throw new Error(`script exhausted for ${who}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }
  of(who: string) {
    return this.requests.filter((r) => r.who === who).map((r) => r.req);
  }
}

let home: string;
let input: PassThrough;
let out: string;
let err: string;
let exitCodes: number[];

const usage = { inputTokens: 1, outputTokens: 1 };
const call = (id: string, name: string, args: unknown): ChatResponse => ({ text: "", toolCalls: [{ id, name, args }], usage });
const say = (text: string): ChatResponse => ({ text, toolCalls: [], usage });

function deps(provider: Provider): CliDeps {
  const o = new PassThrough();
  const e = new PassThrough();
  o.on("data", (d: Buffer) => (out += d.toString()));
  e.on("data", (d: Buffer) => (err += d.toString()));
  return {
    home,
    io: { input, output: o, error: e },
    providerOverride: provider,
    registerInterrupt: () => () => undefined,
    exit: (c) => void exitCodes.push(c),
  };
}
const runTree = (provider: Provider, agent = "boss", goal = "go") =>
  runCli(["run", "demo", "--agent", agent, goal], deps(provider));
const actions = () => {
  const db = openDb(home);
  try {
    return new ActionLog(db, []).list("demo");
  } finally {
    db.close();
  }
};
const editConfig = (fn: (c: ReturnType<typeof configOf>) => void) => {
  const c = configOf();
  fn(c);
  saveProjectConfig(home, c);
};
const configOf = () => {
  const r = loadProjectConfig(home, "demo");
  if (!r.ok) throw new Error(r.error);
  return r.config;
};

async function setup(models: { boss?: string; mgr?: string; ada?: string } = {}) {
  const quiet = deps(new Router({}));
  expect(await runCli(["init", "demo"], quiet)).toBe(0);
  for (const [id, name, role, model] of [
    ["boss", "Boss", "boss", models.boss ?? "lmstudio/test"],
    ["mgr", "Mgr", "manager", models.mgr ?? "lmstudio/test"],
    ["ada", "Ada", "worker", models.ada ?? "lmstudio/test"],
  ]) {
    expect(await runCli(["agent", "create", id, "--name", name, "--role", role, "--model", model, "--persona", `You are ${name}.`], quiet)).toBe(0);
    expect(await runCli(["grant", "demo", id], quiet)).toBe(0);
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tree-"));
  input = new PassThrough();
  out = "";
  err = "";
  exitCodes = [];
});

describe("single agent runs", () => {
  it("offers only the built-in tools the project allows", async () => {
    await setup();
    editConfig((c) => void (c.allowedTools = ["read_file", "remember"]));
    const router = new Router({ Ada: [say("ok")] });
    await runTree(router, "ada");
    expect(router.of("Ada")[0].tools.map((t) => t.name).sort()).toEqual(["list_files", "read_file", "remember", "search_files"]);
  });

  it("without remember in allowedTools no agent gets the remember tool", async () => {
    await setup();
    editConfig((c) => void (c.allowedTools = c.allowedTools.filter((t) => t !== "remember")));
    const router = new Router({ Boss: [say("x")] });
    await runTree(router);
    expect(router.of("Boss")[0].tools.map((t) => t.name)).not.toContain("remember");
  });

  it("init enables remember and not delegate", async () => {
    expect(await runCli(["init", "demo"], deps(new Router({})))).toBe(0);
    const c = configOf();
    expect(c.allowedTools).not.toContain("delegate");
    expect(c.allowedTools).toContain("remember");
    expect(c.allowedTools).toContain("read_file");
  });
});

describe("approver factory and build wiring", () => {
  const stub = () => {
    const seen: string[] = [];
    const approver: ClosableApprover = {
      decide: async (req) => {
        seen.push(req.tool);
        return "approved";
      },
      cancel: () => undefined,
      close: () => undefined,
    };
    return { seen, factory: () => approver };
  };
  const runWith = (provider: Provider, approverFactory: CliDeps["approverFactory"]) =>
    runCli(["run", "demo", "--agent", "boss", "go"], { ...deps(provider), approverFactory });

  it("a tier 2 call goes to the injected approver, not the terminal", async () => {
    await setup();
    const s = stub();
    const router = new Router({ Boss: [call("1", "send_message", { to: "b1", body: "x" }), say("ok")] });
    expect(await runWith(router, s.factory)).toBe(0);
    expect(s.seen).toEqual(["send_message"]);
    expect(out).not.toContain("Approve?");
    expect(fs.readdirSync(projectDirs(home, "demo").outbox).length).toBe(1);
  });

  it("build on a claimed plot is denied plot_taken and never reaches the approver", async () => {
    await setup();
    editConfig((c) => void c.allowedTools.push("build"));
    const db = openDb(home);
    try {
      new CityPlots(db).claim({ plot: 2, kind: "house", projectId: "other", agentId: "z" });
    } finally {
      db.close();
    }
    const s = stub();
    const router = new Router({ Boss: [call("1", "build", { plot: 2, kind: "library" }), say("ok")] });
    expect(await runWith(router, s.factory)).toBe(0);
    expect(s.seen).toEqual([]);
    const gate = actions().find((a) => a.type === "gate.decision" && JSON.stringify(a.payload).includes("build"));
    expect(JSON.stringify(gate!.payload)).toContain("plot_taken");
  });
});
