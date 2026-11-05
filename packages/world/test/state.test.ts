import { describe, expect, it } from "vitest";
import type { ActionRow } from "@agentcity/safety";
import { CityModel, homeOf, workOf, type AgentInfo, type WorldCtx } from "../src/index.js";
import type { ApprovalView, PlotView } from "../src/shared/index.js";

const boss: AgentInfo = { id: "boss", name: "Boss", role: "boss", building: "software" };
const mgr: AgentInfo = { id: "mgr", name: "Mgr", role: "manager", building: "software" };
const dev: AgentInfo = { id: "dev", name: "Dev", role: "worker", building: "software" };
const art: AgentInfo = { id: "art", name: "Art", role: "worker", building: "visual" };

const ctxOf = (plots: PlotView[] = [], now = 1000): WorldCtx => ({
  agents: [boss, mgr, dev, art], plots, now, redactText: (s) => s.split("sekret123").join("[secret]"),
});
let n = 0;
const row = (agentId: string, type: string, payload: unknown = {}): ActionRow => ({
  id: ++n, ts: "2026-10-31T00:00:00.000Z", projectId: "p1", agentId, type, payload, usd: 0, runId: "r1", parentRunId: null,
});
const tool = (agentId: string, name: string, args: unknown): ActionRow => row(agentId, "tool.requested", { call: { id: "c", name, args } });

function model(plots: PlotView[] = []) {
  const m = new CityModel();
  const ctx = ctxOf(plots);
  m.sync(ctx);
  const get = (id: string) => m.state().agents.find((a) => a.id === id)!;
  return { m, ctx, get };
}

describe("CityModel", () => {
  it("sync: idle at home per role, drops deleted agents", () => {
    const { m, ctx, get } = model();
    expect(get("boss")).toMatchObject({ activity: "idle", buildingId: "director" });
    expect(get("mgr")).toMatchObject({ activity: "idle", buildingId: "hq" });
    expect(get("dev")).toMatchObject({ activity: "idle", buildingId: "software" });
    expect(get("art")).toMatchObject({ activity: "idle", buildingId: "visual" });
    m.sync({ ...ctx, agents: [dev] });
    expect(m.state().agents.map((a) => a.id)).toEqual(["dev"]);
  });

  it("homeOf and workOf", () => {
    expect(homeOf(boss)).toBe("director");
    expect(workOf(dev, "thinking", [])).toBe("software");
    expect(workOf(art, "reading", [])).toBe("visual");
  });

  it("run.started: thinking at work building", () => {
    const { m, ctx, get } = model();
    m.applyRows([row("dev", "run.started")], ctx);
    expect(get("dev")).toMatchObject({ activity: "thinking", buildingId: "software", projectId: "p1", runId: "r1" });
  });

  it("model.call: thinking, building stays", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "send_message", { to: "x", body: "b" }), row("dev", "model.call")], ctx);
    expect(get("dev")).toMatchObject({ activity: "thinking", buildingId: "hq" });
  });

  it("read_file: reading at work building", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "read_file", { path: "a.md" })], ctx);
    expect(get("dev")).toMatchObject({ activity: "reading", buildingId: "software", lastText: "read_file a.md" });
  });

  it("write_file: writing, lastText is name and path", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "write_file", { path: "notes/a.md", content: "x" })], ctx);
    expect(get("dev")).toMatchObject({ activity: "writing", buildingId: "software", lastText: "write_file notes/a.md" });
  });

  it("send_message: messaging at hq", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "send_message", { to: "anna", body: "b" })], ctx);
    expect(get("dev")).toMatchObject({ activity: "messaging", buildingId: "hq", lastText: "send_message anna" });
  });

  it("delegate: delegating at hq", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("mgr", "delegate", { agent: "dev", task: "t" })], ctx);
    expect(get("mgr")).toMatchObject({ activity: "delegating", buildingId: "hq", lastText: "delegate dev" });
  });

  it("remember: remembering at home", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "read_file", { path: "a" }), tool("dev", "remember", { note: "n" })], ctx);
    expect(get("dev")).toMatchObject({ activity: "remembering", buildingId: "software", lastText: "remember" });
    m.applyRows([tool("boss", "remember", { note: "n" })], ctx);
    expect(get("boss")).toMatchObject({ activity: "remembering", buildingId: "director" });
  });

  it("build: building at hq", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "build", { plot: 3, kind: "library" })], ctx);
    expect(get("dev")).toMatchObject({ activity: "building", buildingId: "hq", lastText: "build plot-3 library" });
  });

  it("run.stopped: stopped at home, idle after 5000 ms", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "write_file", { path: "a" }), row("dev", "run.stopped")], ctx);
    expect(get("dev")).toMatchObject({ activity: "stopped", buildingId: "software" });
    m.tick(ctx.now + 4999);
    expect(get("dev").activity).toBe("stopped");
    m.tick(ctx.now + 5000);
    expect(get("dev")).toMatchObject({ activity: "idle", buildingId: "software" });
    expect(get("dev").lastText).toBeUndefined();
  });

  it("model.result, tool.result, gate.decision keep activity", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "write_file", { path: "a" })], ctx);
    const before = get("dev");
    m.applyRows([row("dev", "model.result"), row("dev", "tool.result"), row("dev", "gate.decision"), tool("dev", "other_tool", {})], ctx);
    expect(get("dev")).toEqual(before);
  });

  it("boss idle at director, manager idle at hq", () => {
    const { get } = model();
    expect(get("boss").buildingId).toBe("director");
    expect(get("mgr").buildingId).toBe("hq");
  });

  it("visual worker writes at visual", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("art", "write_file", { path: "a.png" })], ctx);
    expect(get("art")).toMatchObject({ activity: "writing", buildingId: "visual" });
  });

  it("built workshop plot: writing goes there, lowest plot wins", () => {
    const plots: PlotView[] = [
      { id: "plot-1" }, { id: "plot-2", kind: "house", builtBy: "x" },
      { id: "plot-4", kind: "workshop", builtBy: "x" }, { id: "plot-3", kind: "workshop", builtBy: "x" },
    ];
    const { m, ctx, get } = model(plots);
    m.applyRows([tool("dev", "write_file", { path: "a" })], ctx);
    expect(get("dev").buildingId).toBe("plot-3");
    m.applyRows([tool("dev", "read_file", { path: "a" })], ctx);
    expect(get("dev").buildingId).toBe("software");
  });

  it("built library plot: reading goes there", () => {
    const { m, ctx, get } = model([{ id: "plot-5", kind: "library", builtBy: "x" }]);
    m.applyRows([tool("dev", "read_file", { path: "a" })], ctx);
    expect(get("dev").buildingId).toBe("plot-5");
  });

  it("built studio: visual agent goes there for any work activity", () => {
    const { m, ctx, get } = model([{ id: "plot-2", kind: "studio", builtBy: "x" }]);
    m.applyRows([row("art", "run.started")], ctx);
    expect(get("art").buildingId).toBe("plot-2");
    m.applyRows([tool("art", "write_file", { path: "a" })], ctx);
    expect(get("art").buildingId).toBe("plot-2");
    m.applyRows([tool("dev", "write_file", { path: "a" })], ctx);
    expect(get("dev").buildingId).toBe("software");
  });

  it("unknown agent rows are ignored", () => {
    const { m, ctx } = model();
    const before = JSON.stringify(m.state());
    m.applyRows([tool("ghost", "write_file", { path: "a" })], ctx);
    expect(JSON.stringify(m.state())).toBe(before);
  });

  it("lastText goes through redactText and is cut to 60 chars", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "write_file", { path: "sekret123.md" })], ctx);
    expect(get("dev").lastText).toBe("write_file [secret].md");
    m.applyRows([tool("dev", "write_file", { path: "a".repeat(100) })], ctx);
    expect(get("dev").lastText).toHaveLength(60);
  });

  it("pending approval shows waiting_approval at hq, then restores", () => {
    const { m, ctx, get } = model();
    m.applyRows([tool("dev", "write_file", { path: "a" })], ctx);
    const ap: ApprovalView = { id: 1, projectId: "p1", agentId: "dev", tool: "send_message", argsPreview: "{}", tier: 2, estimatedUsd: 0, local: false };
    m.setApprovals([ap], ctx);
    expect(get("dev")).toMatchObject({ activity: "waiting_approval", buildingId: "hq" });
    expect(m.state().approvals).toEqual([ap]);
    m.setApprovals([], ctx);
    expect(get("dev")).toMatchObject({ activity: "writing", buildingId: "software" });
  });
});
