import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { FakeProvider, type ChatResponse } from "@agentcity/core";
import { ActionLog, CityPlots, loadProjectConfig, openDb, projectDirs, saveProjectConfig } from "@agentcity/safety";
import { runCli } from "../src/wire.js";
import { RunHost } from "../src/run-host.js";
import { WebApprovals } from "../src/web-approver.js";

const usage = { inputTokens: 1, outputTokens: 1 };
const call = (id: string, name: string, args: unknown): ChatResponse => ({ text: "", toolCalls: [{ id, name, args }], usage });
const say = (text: string): ChatResponse => ({ text, toolCalls: [], usage });

let home: string;
let db: ReturnType<typeof openDb>;
let lines: string[];
let approvals: WebApprovals;

const waitFor = async (pred: () => boolean) => {
  for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(pred()).toBe(true);
};
const host = (script: ChatResponse[]) =>
  new RunHost({
    home, db, secrets: [], keys: {},
    providerOverride: new FakeProvider(script), approvals, out: (l) => lines.push(l),
  });
const outbox = () => fs.readdirSync(projectDirs(home, "demo").outbox).length;
const stops = () =>
  new ActionLog(db, []).list("demo").filter((a) => a.type === "run.stopped").map((a) => (a.payload as { reason: string }).reason);
const send = (id: string) => call(id, "send_message", { to: "x", body: "hi" });

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-host-"));
  const io = { input: new PassThrough(), output: new PassThrough(), error: new PassThrough() };
  expect(await runCli(["init", "demo"], { home, io })).toBe(0);
  expect(await runCli(["agent", "create", "ada", "--name", "Ada", "--model", "lmstudio/test", "--persona", "You are Ada."], { home, io })).toBe(0);
  expect(await runCli(["grant", "demo", "ada"], { home, io })).toBe(0);
  db = openDb(home);
  lines = [];
  approvals = new WebApprovals();
});
afterEach(() => {
  db.close();
});

const allowBuild = () => {
  const r = loadProjectConfig(home, "demo");
  if (!r.ok) throw new Error(r.error);
  r.config.allowedTools.push("build");
  saveProjectConfig(home, r.config);
};

describe("RunHost with web approvals", () => {
  it("a tier 2 call waits, then runs after answer approved", async () => {
    const h = host([send("1"), say("done")]);
    let changes = 0;
    approvals.onChange(() => changes++);
    expect(h.start("demo", "ada", "go")).toEqual({ ok: true });
    await waitFor(() => approvals.waiting().size === 1);
    expect(outbox()).toBe(0);
    const id = [...approvals.waiting()][0];
    expect(approvals.answer(999, "approved")).toBe(false);
    expect(approvals.answer(id, "approved")).toBe(true);
    await waitFor(() => !h.busy("demo"));
    expect(outbox()).toBe(1);
    expect(approvals.waiting().size).toBe(0);
    expect(changes).toBe(2);
    expect(lines.some((l) => l.includes("run.stopped done"))).toBe(true);
  });

  it("claim marks a project busy until released", async () => {
    const h = host([say("done")]);
    const release = h.claim("demo");
    expect(release).toBeTypeOf("function");
    expect(h.busy("demo")).toBe(true);
    expect(h.claim("demo")).toBeUndefined();
    expect(h.start("demo", "ada", "go")).toEqual({ ok: false, error: "project busy" });
    release!();
    expect(h.busy("demo")).toBe(false);
    expect(h.start("demo", "ada", "go")).toEqual({ ok: true });
    await h.stopAll();
  });

  it("start re-reads secrets.json and refreshes the shared key and redaction lists", async () => {
    const secrets: string[] = [];
    const keys: Record<string, string> = {};
    const h = new RunHost({
      home, db, secrets, keys,
      providerOverride: new FakeProvider([say("done")]), approvals, out: (l) => lines.push(l),
    });
    fs.writeFileSync(path.join(home, "secrets.json"), JSON.stringify({ openai: "sk-fresh-key" }));
    expect(h.start("demo", "ada", "go")).toEqual({ ok: true });
    expect(keys).toEqual({ openai: "sk-fresh-key" });
    expect(secrets).toEqual(["sk-fresh-key"]);
    await h.stopAll();
  });

  it("a second start on a busy project is refused", async () => {
    const h = host([send("1"), say("done")]);
    expect(h.start("demo", "ada", "go")).toEqual({ ok: true });
    expect(h.start("demo", "ada", "again")).toEqual({ ok: false, error: "project busy" });
    await h.stopAll();
  });

  it("reports unknown agent and missing project", () => {
    const h = host([]);
    expect(h.start("demo", "nobody", "go")).toEqual({ ok: false, error: "no agent nobody" });
    expect(h.start("ghost", "ada", "go")).toEqual({ ok: false, error: "project ghost missing" });
  });

  it("stopAll denies a waiting approval and ends the run", async () => {
    const h = host([send("1"), say("done")]);
    h.start("demo", "ada", "go");
    await waitFor(() => approvals.waiting().size === 1);
    await h.stopAll();
    expect(h.busy("demo")).toBe(false);
    expect(approvals.waiting().size).toBe(0);
    expect(outbox()).toBe(0);
    expect(["interrupted", "aborted", "user_denied"]).toContain(stops()[0]);
  });

  it("build with a free plot writes a city_plots row after approval", async () => {
    allowBuild();
    const h = host([call("1", "build", { plot: 2, kind: "library" }), say("built")]);
    h.start("demo", "ada", "go");
    await waitFor(() => approvals.waiting().size === 1);
    expect(new CityPlots(db).taken(2)).toBe(false);
    approvals.answer([...approvals.waiting()][0], "approved");
    await waitFor(() => !h.busy("demo"));
    expect(new CityPlots(db).list()).toMatchObject([{ plot: 2, kind: "library", projectId: "demo", agentId: "ada" }]);
  });

  it("build on a taken plot is denied with plot_taken and no approval", async () => {
    allowBuild();
    new CityPlots(db).claim({ plot: 3, kind: "house", projectId: "other", agentId: "z" });
    const h = host([call("1", "build", { plot: 3, kind: "library" }), say("ok")]);
    h.start("demo", "ada", "go");
    await waitFor(() => !h.busy("demo"));
    expect(approvals.waiting().size).toBe(0);
    expect(new CityPlots(db).list()).toHaveLength(1);
    const denied = new ActionLog(db, []).list("demo").some((a) => JSON.stringify(a.payload).includes("plot_taken"));
    expect(denied).toBe(true);
  });

  it("build without build in allowedTools is not offered", async () => {
    const p = new FakeProvider([say("ok")]);
    const h = new RunHost({ home, db, secrets: [], keys: {}, providerOverride: p, approvals, out: () => undefined });
    h.start("demo", "ada", "go");
    await waitFor(() => !h.busy("demo"));
    expect(p.requests[0].tools.map((t) => t.name)).not.toContain("build");
  });
});
