import { describe, expect, it } from "vitest";
import type { Goal, Task } from "@agentcity/safety";
import type { ApprovalView } from "@agentcity/world/shared";
import { DECISIONS_MAX, listDecisions, trackSeen } from "../src/decisions.js";

function approval(id: number, agentId: string, projectId = "game"): ApprovalView {
  return { id, projectId, agentId, tool: "run_command", argsPreview: "npm test", tier: 2, estimatedUsd: 0.01, local: false };
}

function goal(over: Partial<Goal> & { id: string }): Goal {
  return {
    projectId: "game", text: "make pong", status: "planning", plan: "Steps: make pong.", planState: "proposed", planBy: "boss",
    createdAt: "2026-11-03T09:00:00.000Z", updatedAt: "2026-11-03T09:00:00.000Z", ...over,
  };
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    goalId: "g1", parentId: "t1", projectId: "game", title: "work", description: "", assignee: "ada", deps: [],
    status: "todo", branch: null, worktree: null, summary: null, blockedReason: null, checkpoint: null, held: false, heldByParent: false, ci: "none", testOutput: null,
    sendBacks: 0, nudges: 0, testFixes: 0, conflicts: 0, createdBy: "manager",
    createdAt: "2026-11-03T09:00:00.000Z", updatedAt: "2026-11-03T09:00:00.000Z", ...over,
  };
}

describe("listDecisions", () => {
  it("orders approvals, questions and merges oldest first, ties by id", () => {
    const seen = new Map([[7, "2026-11-03T10:00:02.000Z"]]);
    const r = listDecisions({ activeGoals: new Set(["g1"]), goals: [], approvals: [approval(7, "ada")], seen, tasks: [
      task({ id: "t3", status: "blocked", blockedReason: "Which colour?", updatedAt: "2026-11-03T10:00:01.000Z" }),
      task({ id: "t4", status: "approval", summary: "added footer", updatedAt: "2026-11-03T10:00:01.000Z" }),
    ] });
    expect(r.list.map((d) => d.id)).toEqual(["b:t3", "m:t4", "a:7"]);
    expect(r.list[0]).toMatchObject({ kind: "blocked", title: "work", text: "Which colour?", taskId: "t3" });
    expect(r.list[1]).toMatchObject({ kind: "merge", text: "added footer" });
    expect(r.list[2]).toMatchObject({ kind: "approval", approvalId: 7, agentId: "ada", text: "", title: "run_command: npm test", since: "2026-11-03T10:00:02.000Z" });
  });

  it("a proposed plan is a plan decision with goalId and the boss", () => {
    const r = listDecisions({ activeGoals: new Set(["g1"]), goals: [
      goal({ id: "g3", updatedAt: "2026-11-03T10:00:01.000Z" }),
      goal({ id: "g4", planBy: null, plan: null, updatedAt: "2026-11-03T10:00:09.000Z" }),
    ], approvals: [], seen: new Map(), tasks: [
      task({ id: "t9", status: "approval", summary: "x", updatedAt: "2026-11-03T10:00:05.000Z" }),
    ] });
    expect(r.list.map((d) => d.id)).toEqual(["p:g3", "m:t9", "p:g4"]);
    expect(r.list[0]).toEqual({
      id: "p:g3", kind: "plan", projectId: "game", agentId: "boss", goalId: "g3",
      title: "Plan: make pong", text: "Steps: make pong.", since: "2026-11-03T10:00:01.000Z",
    });
    expect(r.list[2]).toMatchObject({ agentId: "boss", text: "" });
  });

  it("keeps at most 200, the oldest", () => {
    const base = Date.UTC(2026, 10, 3, 10, 0, 0);
    const tasks = Array.from({ length: 205 }, (_, i) =>
      task({ id: `t${i + 1}`, status: "approval", summary: "done", updatedAt: new Date(base + i * 1000).toISOString() }));
    const r = listDecisions({ activeGoals: new Set(["g1"]), goals: [], approvals: [], seen: new Map(), tasks });
    expect(DECISIONS_MAX).toBe(200);
    expect(r.list).toHaveLength(200);
    expect(r.list[0].id).toBe("m:t1");
    expect(r.list[199].id).toBe("m:t200");
  });

  it("failing lists agents with a doing or review task whose ci failed", () => {
    const r = listDecisions({ activeGoals: new Set(["g1"]), goals: [], approvals: [], seen: new Map(), tasks: [
      task({ id: "t5", status: "doing", ci: "fail" }),
      task({ id: "t6", status: "review", ci: "pass", assignee: "bo" }),
      task({ id: "t7", status: "todo", ci: "fail", assignee: "cy" }),
    ] });
    expect(r.failing).toEqual(["ada"]);
  });

  it("an unassigned task waits on its creator, and an approval without a first-seen time sorts first", () => {
    const r = listDecisions({ activeGoals: new Set(["g1"]), goals: [], approvals: [approval(9, "bo")], seen: new Map(), tasks: [
      task({ id: "t8", status: "blocked", assignee: null, createdBy: "boss", blockedReason: "Which colour?", updatedAt: "2026-11-03T10:00:00.000Z" }),
    ] });
    expect(r.list.map((d) => d.id)).toEqual(["a:9", "b:t8"]);
    expect(r.list[1].agentId).toBe("boss");
  });
});

describe("listDecisions blocked tasks", () => {
  it("a blocked task of an active goal is a blocked decision with its title and reason", () => {
    const r = listDecisions({ activeGoals: new Set(["g1"]), goals: [], approvals: [], seen: new Map(), tasks: [
      task({ id: "t10", status: "blocked", title: "Footer", blockedReason: "Which color?", updatedAt: "2026-11-03T10:00:00.000Z" }),
    ] });
    expect(r.list).toEqual([{
      id: "b:t10", kind: "blocked", projectId: "game", agentId: "ada", taskId: "t10",
      title: "Footer", text: "Which color?", since: "2026-11-03T10:00:00.000Z",
    }]);
  });

  it("a blocked task of a cancelled or done goal is not listed", () => {
    const r = listDecisions({ activeGoals: new Set(["g1"]), goals: [], approvals: [], seen: new Map(), tasks: [
      task({ id: "t11", goalId: "g2", status: "blocked", blockedReason: "Which color?" }),
    ] });
    expect(r.list).toEqual([]);
  });
});

describe("trackSeen", () => {
  it("drops ids that left the list and gives new ids the time", () => {
    const seen = new Map([[1, "2026-11-03T10:00:00.000Z"], [2, "2026-11-03T10:00:01.000Z"]]);
    trackSeen(seen, [2, 3], "2026-11-03T10:00:05.000Z");
    expect([...seen]).toEqual([[2, "2026-11-03T10:00:01.000Z"], [3, "2026-11-03T10:00:05.000Z"]]);
  });

  it("keeps the first time of an id that stays", () => {
    const seen = new Map<number, string>();
    trackSeen(seen, [4], "2026-11-03T10:00:00.000Z");
    trackSeen(seen, [4], "2026-11-03T10:00:09.000Z");
    expect(seen.get(4)).toBe("2026-11-03T10:00:00.000Z");
  });
});
