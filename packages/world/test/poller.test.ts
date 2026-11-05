import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActionLog, ApprovalQueue, CityPlots, openDb } from "@agentcity/safety";
import { CityFeed, Ticker, type AgentInfo } from "../src/index.js";

type Db = ReturnType<typeof openDb>;
const dbs: Db[] = [];
const tmpDb = (): Db => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), "agentcity-world-")));
  dbs.push(db);
  return db;
};
function setup(agents: AgentInfo[] = [], local: number[] = []) {
  const db = tmpDb();
  const list = { agents };
  const feed = new CityFeed(db, {
    listAgents: () => list.agents,
    localApprovalIds: () => new Set(local),
    redactText: (s) => s.split("sekret123").join("[secret]"),
    now: () => 1_000_000,
  });
  return { db, log: new ActionLog(db, []), feed, list };
}
afterEach(() => { while (dbs.length) dbs.pop()!.close(); vi.useRealTimers(); });

const dev: AgentInfo = { id: "dev", name: "Dev", role: "worker", building: "software" };
const mgr: AgentInfo = { id: "mgr", name: "Mgr", role: "manager", building: "software" };
const write = (log: ActionLog, agentId: string, p: string) =>
  log.append({ projectId: "p", agentId, type: "tool.requested", payload: { call: { id: "c", name: "write_file", args: { path: p } } }, runId: "r" });
const never = { decide: () => new Promise<never>(() => {}) };

describe("CityFeed", () => {
  it("first poll reports all agents and six plots", () => {
    const { feed } = setup([dev, mgr]);
    const r = feed.poll();
    expect(r.changed.agents.map((a) => a.id)).toEqual(["dev", "mgr"]);
    expect(r.state.plots.map((p) => p.id)).toEqual(["plot-1", "plot-2", "plot-3", "plot-4", "plot-5", "plot-6"]);
    expect(r.changed.approvals).toEqual([]);
  });

  it("second poll returns only agents changed by new rows", () => {
    const { feed, log } = setup([dev, mgr]);
    feed.poll();
    expect(feed.poll().changed).toEqual({ agents: [], plots: [] });
    write(log, "dev", "notes/a.md");
    const r = feed.poll();
    expect(r.changed.agents.map((a) => a.id)).toEqual(["dev"]);
    expect(r.changed.agents[0]).toMatchObject({ activity: "writing", lastText: "write_file notes/a.md" });
    expect(r.changed.approvals).toBeUndefined();
    expect(feed.poll().changed.agents).toEqual([]);
  });

  it("an agent created between polls appears", () => {
    const { feed, list } = setup([dev]);
    feed.poll();
    list.agents = [dev, mgr];
    const r = feed.poll();
    expect(r.changed.agents.map((a) => a.id)).toEqual(["mgr"]);
    expect(r.state.agents).toHaveLength(2);
  });

  it("600 rows before the first poll: state from the last 500 only", () => {
    const { feed, log } = setup([dev, mgr]);
    for (let i = 0; i < 100; i++) write(log, "mgr", "old");
    for (let i = 0; i < 500; i++) write(log, "dev", "new");
    const r = feed.poll();
    expect(r.state.agents.find((a) => a.id === "mgr")).toMatchObject({ activity: "idle" });
    // History alone never shows anyone busy; the cursor still starts after the last row.
    expect(r.state.agents.find((a) => a.id === "dev")).toMatchObject({ activity: "idle" });
    expect(feed.poll().changed.agents).toEqual([]);
  });

  it("runs a restart killed: history leaves nobody busy and no run open", () => {
    const { feed, log } = setup([dev, mgr]);
    log.append({ projectId: "p", agentId: "mgr", type: "run.started", payload: { goal: "g" }, runId: "top" });
    log.append({ projectId: "p", agentId: "mgr", type: "tool.requested", payload: { call: { id: "c", name: "delegate", args: { agent: "dev" } } }, runId: "top" });
    log.append({ projectId: "p", agentId: "dev", type: "run.started", payload: { goal: "t" }, runId: "kid", parentRunId: "top" });
    log.append({ projectId: "p", agentId: "dev", type: "tool.requested", payload: { call: { id: "d", name: "send_message", args: { to: "human" } } }, runId: "kid" });
    const r = feed.poll();
    expect(r.state.agents.map((a) => a.activity)).toEqual(["idle", "idle"]);
    expect(r.state.runs).toEqual([]);
    write(log, "dev", "a.ts");
    expect(feed.poll().state.agents[0]).toMatchObject({ activity: "writing" });
  });

  it("a stopped top run stops every agent of its tree", () => {
    const { feed, log } = setup([dev, mgr]);
    feed.poll();
    log.append({ projectId: "p", agentId: "mgr", type: "run.started", payload: { goal: "g" }, runId: "top" });
    log.append({ projectId: "p", agentId: "mgr", type: "tool.requested", payload: { call: { id: "c", name: "delegate", args: { agent: "dev" } } }, runId: "top" });
    log.append({ projectId: "p", agentId: "dev", type: "run.started", payload: { goal: "t" }, runId: "kid", parentRunId: "top" });
    log.append({ projectId: "p", agentId: "dev", type: "tool.requested", payload: { call: { id: "d", name: "send_message", args: { to: "human" } } }, runId: "kid" });
    expect(feed.poll().state.agents.map((a) => a.activity)).toEqual(["messaging", "delegating"]);
    log.append({ projectId: "p", agentId: "mgr", type: "run.stopped", payload: { reason: "interrupted", steps: 0 }, runId: "top" });
    expect(feed.poll().state.agents.map((a) => a.activity)).toEqual(["stopped", "stopped"]);
  });

  it("approvals: local flag, redacted preview cut to 120 chars, set only on change", () => {
    const { db, feed } = setup([dev], [1]);
    const q = new ApprovalQueue(db);
    void q.request({ projectId: "p", agentId: "dev", tool: "send_message", args: { body: "sekret123" + "x".repeat(200) }, tier: 2, estimatedUsd: 0.1 }, never);
    void q.request({ projectId: "p", agentId: "mgr", tool: "build", args: { plot: 1 }, tier: 2, estimatedUsd: 0 }, never);
    const r = feed.poll();
    const [a, b] = r.changed.approvals!;
    expect(a).toMatchObject({ id: 1, local: true, tool: "send_message" });
    expect(a!.argsPreview).toHaveLength(120);
    expect(a!.argsPreview).toContain("[secret]");
    expect(a!.argsPreview).not.toContain("sekret123");
    expect(b).toMatchObject({ id: 2, local: false });
    expect(r.state.agents[0]).toMatchObject({ activity: "waiting_approval", buildingId: "hq" });
    expect(feed.poll().changed.approvals).toBeUndefined();
  });

  it("built plot appears in plots and sends writers there", () => {
    const { db, feed, log } = setup([dev]);
    feed.poll();
    new CityPlots(db).claim({ plot: 2, kind: "workshop", projectId: "p", agentId: "dev" });
    write(log, "dev", "a");
    const r = feed.poll();
    expect(r.changed.plots).toEqual([{ id: "plot-2", kind: "workshop", builtBy: "dev" }]);
    expect(r.changed.agents[0]!.buildingId).toBe("plot-2");
  });

  it("a pendingAll error keeps the new rows for the next poll", () => {
    const { feed, log } = setup([dev]);
    feed.poll();
    write(log, "dev", "notes/a.md");
    const spy = vi.spyOn(ApprovalQueue.prototype, "pendingAll").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => feed.poll()).toThrow("boom");
    spy.mockRestore();
    const r = feed.poll();
    expect(r.state.agents[0]).toMatchObject({ activity: "writing", lastText: "write_file notes/a.md" });
    expect(r.changed.agents.map((a) => a.id)).toEqual(["dev"]);
  });

  it("stopped turns idle once the clock passes 5000 ms", () => {
    let t = 1_000_000;
    const db = tmpDb();
    const feed = new CityFeed(db, { listAgents: () => [dev], localApprovalIds: () => new Set(), redactText: (s) => s, now: () => t });
    new ActionLog(db, []).append({ projectId: "p", agentId: "dev", type: "run.stopped", payload: { reason: "done" }, runId: "r" });
    expect(feed.poll().state.agents[0]!.activity).toBe("stopped");
    t += 5000;
    const r = feed.poll();
    expect(r.state.agents[0]!.activity).toBe("idle");
    expect(r.changed.agents).toHaveLength(1);
  });
});

describe("Ticker", () => {
  it("calls fn every ms until stopped", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = new Ticker(fn, 250);
    t.start();
    t.start();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(4);
    t.stop();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
