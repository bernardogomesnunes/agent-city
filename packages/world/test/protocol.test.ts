import { describe, it, expect } from "vitest";
import { parseClientMsg, ServerMsgSchema, DecisionViewSchema, type CityState } from "../src/shared/index.js";

describe("DecisionViewSchema", () => {
  it("accepts a blocked decision and rejects the old question kind", () => {
    const view = { id: "b:t1", kind: "blocked", projectId: "game", agentId: "ada", taskId: "t1", title: "Footer", text: "Which color?", since: "2026-11-03T10:00:00.000Z" };
    expect(DecisionViewSchema.safeParse(view).success).toBe(true);
    expect(DecisionViewSchema.safeParse({ ...view, kind: "question" }).success).toBe(false);
  });
});

describe("parseClientMsg", () => {
  it("accepts approve, run and term.in", () => {
    expect(parseClientMsg('{"type":"approve","id":3,"decision":"approved"}')).toEqual({ type: "approve", id: 3, decision: "approved" });
    expect(parseClientMsg('{"type":"run","projectId":"p","agentId":"a","goal":"g"}')).toMatchObject({ type: "run", goal: "g" });
    expect(parseClientMsg('{"type":"term.in","line":"agent list"}')).toEqual({ type: "term.in", line: "agent list" });
  });
  it("rejects approve without decision, wrong id type and unknown type", () => {
    expect(parseClientMsg('{"type":"approve","id":"x"}')).toBeNull();
    expect(parseClientMsg('{"type":"approve","id":1,"decision":"maybe"}')).toBeNull();
    expect(parseClientMsg('{"type":"nope"}')).toBeNull();
  });
  it("accepts models.list and agent.model, rejects an empty or long model", () => {
    expect(parseClientMsg('{"type":"models.list"}')).toEqual({ type: "models.list" });
    expect(parseClientMsg('{"type":"agent.model","agentId":"ada","model":"claude-sub/haiku"}')).toEqual({ type: "agent.model", agentId: "ada", model: "claude-sub/haiku" });
    expect(parseClientMsg('{"type":"agent.model","agentId":"ada","model":""}')).toBeNull();
    expect(parseClientMsg(JSON.stringify({ type: "agent.model", agentId: "ada", model: "x".repeat(201) }))).toBeNull();
  });
  it("rejects non-JSON", () => {
    expect(parseClientMsg("not json")).toBeNull();
    expect(parseClientMsg("")).toBeNull();
  });
});

describe("ServerMsgSchema", () => {
  const state: CityState = {
    agents: [{ id: "ada", name: "Ada", role: "worker", building: "visual", model: "lmstudio/q", activity: "idle", buildingId: "visual" }],
    plots: [{ id: "plot-1", kind: "library", builtBy: "ada" }],
    approvals: [{ id: 1, projectId: "p", agentId: "ada", tool: "build", argsPreview: "{}", tier: 2, estimatedUsd: 0, local: true }],
    runs: [],
  };
  it("accepts every server message", () => {
    for (const m of [
      { type: "snapshot", state },
      { type: "patch", agents: state.agents },
      { type: "patch" },
      { type: "term.out", text: "hi" },
      { type: "term.done", code: 0 },
      { type: "error", message: "project busy" },
      { type: "models", groups: [{ label: "LM Studio", models: [], error: "cannot reach x" }] },
      { type: "agent.saved", agentId: "ada", version: 2 },
    ]) expect(ServerMsgSchema.safeParse(m).success).toBe(true);
  });
  it("rejects an agent without building", () => {
    const bad = { type: "snapshot", state: { ...state, agents: [{ ...state.agents[0], building: undefined }] } };
    expect(ServerMsgSchema.safeParse(bad).success).toBe(false);
  });
});

describe("goal board messages", () => {
  it("parses every new client message", () => {
    for (const m of [
      { type: "goal.submit", projectId: "demo", text: "make pong" },
      { type: "board.watch", projectId: "demo" },
      { type: "task.open", taskId: "t1" },
      { type: "task.message", taskId: "t1", text: "faster" },
      { type: "task.action", taskId: "t1", action: "retry" },
      { type: "task.action", taskId: "t1", action: "cancel" },
      { type: "task.action", taskId: "t1", action: "rollback" },
      { type: "task.action", taskId: "t1", action: "pause" },
      { type: "task.action", taskId: "t1", action: "resume" },
      { type: "project.pause", projectId: "demo", paused: true },
      { type: "city.pause", paused: false },
      { type: "task.answer", taskId: "t1", text: "blue" },
      { type: "review.answer", taskId: "t1", option: "merge" },
      { type: "review.answer", taskId: "t1", option: "changes", text: "rename it" },
      { type: "review.answer", taskId: "t1", option: "reject" },
      { type: "plan.answer", goalId: "g1", option: "approve" },
      { type: "plan.answer", goalId: "g1", option: "changes", text: "fewer steps" },
      { type: "diff.request", taskId: "t1" },
      { type: "session.new", agentId: "ada" },
      { type: "session.new", agentId: "ada", projectId: "demo" },
      { type: "session.open", sessionId: 3 },
      { type: "session.open", projectId: "demo", agentId: "ada" },
      { type: "session.send", sessionId: 3, text: "hi" },
      { type: "session.send", projectId: "demo", agentId: "ada", text: "hi" },
    ]) expect(parseClientMsg(JSON.stringify(m)), JSON.stringify(m)).toEqual(m);
  });

  it("rejects a review option ship, an empty goal and a session.open with nothing to open", () => {
    expect(parseClientMsg('{"type":"review.answer","taskId":"t1","option":"ship"}')).toBeNull();
    expect(parseClientMsg('{"type":"goal.submit","projectId":"demo","text":""}')).toBeNull();
    expect(parseClientMsg(JSON.stringify({ type: "goal.submit", projectId: "demo", text: "x".repeat(2001) }))).toBeNull();
    expect(parseClientMsg('{"type":"task.action","taskId":"t1","action":"merge"}')).toBeNull();
    expect(parseClientMsg('{"type":"session.open"}')).toBeNull();
    expect(parseClientMsg('{"type":"session.send","text":"hi"}')).toBeNull();
  });

  const task = {
    id: "t2", goalId: "g1", parentId: "t1", projectId: "demo", title: "ball", description: "d", assignee: "dev", deps: ["t1"],
    status: "approval", branch: "agent/dev/t2", worktree: null, summary: "done", blockedReason: null, ci: "pass", testOutput: null, checkpoint: null, held: false,
    createdBy: "ana", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:01Z",
  };
  const goal = { id: "g1", projectId: "demo", text: "pong", status: "active", createdAt: "a", updatedAt: "b", done: 1, total: 3, planState: "proposed", plan: "Steps." };
  const file = { path: "a.ts", status: "modified", additions: 1, deletions: 1, truncated: false, hunks: [[{ kind: "del", text: "x", oldNo: 1 }, { kind: "add", text: "y", newNo: 1 }]] };

  it("accepts every new server message", () => {
    for (const m of [
      { type: "board", projectId: "demo", goals: [goal], tasks: [task] },
      { type: "task.detail", task, log: [{ ts: "t", agentId: "dev", kind: "tool", text: "write_file" }], files: { entries: [{ path: "a", size: 1, dir: false }], truncated: false }, previewKey: "k", hasIndex: true },
      { type: "task.log", taskId: "t2", rows: [] },
      { type: "diff", taskId: "t2", files: [file] },
      { type: "review.result", taskId: "t2", ok: false, error: "dirty" },
      { type: "review.result", taskId: "t2", ok: true },
      { type: "plan.result", goalId: "g1", ok: true },
      { type: "plan.result", goalId: "g1", ok: false, error: "plan is not waiting" },
      { type: "session.list", sessions: [{ id: 1, projectId: "demo", agentId: "ada", title: "hi", status: "idle", queued: 0, last: "", lastTs: "t" }] },
      { type: "session.list", sessions: [{ id: 1, agentId: "ada", title: "", status: "idle", queued: 0, last: "", lastTs: "t" }] },
      { type: "paused", projectIds: ["demo"] },
    ]) expect(ServerMsgSchema.safeParse(m).success, JSON.stringify(m).slice(0, 60)).toBe(true);
  });

  it("TaskView requires held", () => {
    const noHeld = Object.fromEntries(Object.entries(task).filter(([k]) => k !== "held"));
    expect(ServerMsgSchema.safeParse({ type: "board", projectId: "demo", goals: [], tasks: [noHeld] }).success).toBe(false);
  });

  it("rejects a task with an unknown status and a log row with an unknown kind", () => {
    expect(ServerMsgSchema.safeParse({ type: "board", projectId: "demo", goals: [], tasks: [{ ...task, status: "shipped" }] }).success).toBe(false);
    expect(ServerMsgSchema.safeParse({ type: "task.log", taskId: "t2", rows: [{ ts: "t", agentId: "a", kind: "other", text: "x" }] }).success).toBe(false);
  });
});
