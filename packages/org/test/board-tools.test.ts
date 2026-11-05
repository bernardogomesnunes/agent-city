import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "@agentcity/core";
import { BoardStore, openDb, type Task } from "@agentcity/safety";
import {
  makeCreateTaskTool, makeUpdateTaskTool, makeRequestMergeTool, makeAskPlayerTool, makeCreateGoalTool, makeProposePlanTool,
  type BoardToolCtx,
} from "../src/board-tools.js";

let home: string;
let db: ReturnType<typeof openDb>;
let board: BoardStore;
let goalId: string;
let team: Task;
const runCtx: ToolContext = { projectId: "game", agentId: "x", sandboxDir: "/s", outboxDir: "/o" };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "board-tools-"));
  db = openDb(home);
  board = new BoardStore(db);
  goalId = board.createGoal("game", "make pong").id;
  team = board.createTask({ goalId, title: "pong team", description: "", assignee: "ana", createdBy: "boss" });
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function ctxFor(over: Partial<BoardToolCtx> = {}): BoardToolCtx {
  return {
    board, goalId, agentId: "ana", role: "manager", allowedAssignees: ["dev", "qa"],
    onChange: vi.fn(), onQuestion: vi.fn(), ...over,
  };
}

/** A worker task under the team task, assigned to `assignee`, moved to `status` by its own owner. */
function worker(assignee: string, status: "todo" | "doing" | "review" = "todo", deps: string[] = []): Task {
  const w = board.createTask({ goalId, parentId: team.id, title: "work", description: "", assignee, deps, createdBy: "ana" });
  if (status !== "todo") board.setStatus(w.id, "doing");
  if (status === "review") board.setStatus(w.id, "review");
  return board.task(w.id)!;
}

const idOf = (result: string) => result.replace(/^created /, "");

describe("create_task", () => {
  it("boss without assignee gives a team task to the first manager, with no parent", async () => {
    const ctx = ctxFor({ agentId: "boss", role: "boss", taskId: undefined, allowedAssignees: ["ana", "bob"] });
    const tool = makeCreateTaskTool(ctx);
    const out = await tool.run({ title: "menu", description: "build the menu" }, runCtx);
    const made = board.task(idOf(out))!;
    expect(out).toMatch(/^created t\d+$/);
    expect(made).toMatchObject({ parentId: null, assignee: "ana", createdBy: "boss" });
    expect(ctx.onChange).toHaveBeenCalledOnce();
  });

  it("manager makes a worker task under its team task and refuses an assignee outside the team", async () => {
    const ctx = ctxFor({ taskId: team.id });
    const tool = makeCreateTaskTool(ctx);
    const out = await tool.run({ title: "paddle", description: "", assignee: "dev" }, runCtx);
    expect(board.task(idOf(out))).toMatchObject({ parentId: team.id, assignee: "dev" });

    const before = board.tasks(goalId).length;
    const refused = await tool.run({ title: "x", description: "", assignee: "bob" }, runCtx);
    expect(refused).toBe("error: assignee must be one of dev, qa");
    expect(board.tasks(goalId).length).toBe(before);
  });

  it("worker gets an error and creates nothing", async () => {
    const tool = makeCreateTaskTool(ctxFor({ role: "worker", agentId: "dev", taskId: team.id }));
    const out = await tool.run({ title: "x", description: "" }, runCtx);
    expect(out).toMatch(/^error: /);
    expect(board.tasks(goalId)).toHaveLength(1);
  });

  it("unknown dep returns an error and creates nothing", async () => {
    const tool = makeCreateTaskTool(ctxFor({ taskId: team.id }));
    const out = await tool.run({ title: "x", description: "", assignee: "dev", deps: ["t99"] }, runCtx);
    expect(out).toMatch(/^error: unknown dep t99/);
    expect(board.tasks(goalId)).toHaveLength(1);
  });

  it("a project with no workers refuses a named assignee and reports it to onRejected", async () => {
    const ctx = ctxFor({ taskId: team.id, allowedAssignees: [], onRejected: vi.fn() });
    const tool = makeCreateTaskTool(ctx);
    const before = board.tasks(goalId).length;
    const out = await tool.run({ title: "x", description: "", assignee: "dev" }, runCtx);
    expect(out).toBe("error: this project has no workers; ask the player to grant one");
    expect(ctx.onRejected).toHaveBeenCalledWith(out);
    expect(board.tasks(goalId).length).toBe(before);
  });

  it("a refused assignee is reported to onRejected before the error returns", async () => {
    const ctx = ctxFor({ taskId: team.id, onRejected: vi.fn() });
    const out = await makeCreateTaskTool(ctx).run({ title: "x", description: "", assignee: "bob" }, runCtx);
    expect(out).toBe("error: assignee must be one of dev, qa");
    expect(ctx.onRejected).toHaveBeenCalledWith(out);
  });
});

describe("create_task for the boss", () => {
  const bossCtx = (goal: string) => ctxFor({ goalId: goal, agentId: "boss", role: "boss", taskId: undefined, allowedAssignees: ["ana", "bob"] });
  const freshGoal = () => board.createGoal("game", "plan steps").id;

  it("chains each team task after the one before it", async () => {
    const tool = makeCreateTaskTool(bossCtx(freshGoal()));
    const t1 = idOf(await tool.run({ title: "one", description: "a" }, runCtx));
    const t2 = idOf(await tool.run({ title: "two", description: "b" }, runCtx));
    const t3 = idOf(await tool.run({ title: "three", description: "c" }, runCtx));
    expect(board.task(t1)!.deps).toEqual([]);
    expect(board.task(t2)!.deps).toEqual([t1]);
    expect(board.task(t3)!.deps).toEqual([t2]);
  });

  it("parallel true adds no dep", async () => {
    const tool = makeCreateTaskTool(bossCtx(freshGoal()));
    const t1 = idOf(await tool.run({ title: "one", description: "a" }, runCtx));
    const t2 = idOf(await tool.run({ title: "two", description: "b", parallel: true }, runCtx));
    expect(board.task(t2)!.deps).toEqual([]);
    expect(t1).not.toBe(t2);
  });

  it("explicit deps stay and the previous task is not added to them", async () => {
    const tool = makeCreateTaskTool(bossCtx(freshGoal()));
    const t1 = idOf(await tool.run({ title: "one", description: "a" }, runCtx));
    await tool.run({ title: "two", description: "b", parallel: true }, runCtx);
    const t3 = idOf(await tool.run({ title: "three", description: "c", deps: [t1] }, runCtx));
    expect(board.task(t3)!.deps).toEqual([t1]);
  });

  it("a manager's call adds no chain dep", async () => {
    const tool = makeCreateTaskTool(ctxFor({ taskId: team.id }));
    const out = await tool.run({ title: "paddle", description: "", assignee: "dev" }, runCtx);
    expect(board.task(idOf(out))!.deps).toEqual([]);
  });
});

describe("update_task", () => {
  it("a worker cannot change another agent's task", async () => {
    const other = worker("qa", "doing");
    const tool = makeUpdateTaskTool(ctxFor({ agentId: "dev", role: "worker", taskId: other.id }));
    const out = await tool.run({ task_id: other.id, status: "review", summary: "done" }, runCtx);
    expect(out).toMatch(/^error: /);
    expect(board.task(other.id)!.status).toBe("doing");
  });

  it("a worker cannot move another of its own tasks outside the job's task", async () => {
    const current = worker("dev", "doing");
    const later = worker("dev");
    const tool = makeUpdateTaskTool(ctxFor({ agentId: "dev", role: "worker", taskId: current.id }));
    const out = await tool.run({ task_id: later.id, status: "doing" }, runCtx);
    expect(out).toBe(`error: you work on ${current.id} only`);
    expect(board.task(later.id)!.status).toBe("todo");
  });

  it("a status change rolls up the task's own goal", async () => {
    const other = board.createGoal("game", "second").id;
    const otherTeam = board.createTask({ goalId: other, title: "team 2", description: "", assignee: "ana", createdBy: "boss" });
    const w = board.createTask({ goalId: other, parentId: otherTeam.id, title: "w", description: "", assignee: "dev", createdBy: "ana" });
    board.setStatus(w.id, "doing");
    const spy = vi.spyOn(board, "rollup");
    await makeUpdateTaskTool(ctxFor({ agentId: "dev", role: "worker", taskId: w.id })).run({ task_id: w.id, status: "review", summary: "s" }, runCtx);
    expect(spy).toHaveBeenCalledWith(other);
  });

  it("a worker moves its own task to review with a summary, then rollup and onChange run", async () => {
    const mine = worker("dev", "doing");
    const ctx = ctxFor({ agentId: "dev", role: "worker", taskId: mine.id });
    const out = await makeUpdateTaskTool(ctx).run({ task_id: mine.id, status: "review", summary: "paddle moves" }, runCtx);
    expect(out).toBe(`updated ${mine.id}`);
    expect(board.task(mine.id)).toMatchObject({ status: "review", summary: "paddle moves" });
    expect(ctx.onChange).toHaveBeenCalledOnce();
  });

  it("blocked needs a reason", async () => {
    const mine = worker("dev", "doing");
    const out = await makeUpdateTaskTool(ctxFor({ agentId: "dev", role: "worker" })).run({ task_id: mine.id, status: "blocked" }, runCtx);
    expect(out).toMatch(/^error: /);
    expect(board.task(mine.id)!.status).toBe("doing");
  });

  it("the reviewer sends a task in review back to doing with the changes needed", async () => {
    const mine = worker("dev", "review");
    const out = await makeUpdateTaskTool(ctxFor({ reviewer: "ana", taskId: mine.id })).run({ task_id: mine.id, status: "doing", summary: "add a test" }, runCtx);
    expect(out).toBe(`updated ${mine.id}`);
    expect(board.task(mine.id)).toMatchObject({ status: "doing", summary: "add a test" });
  });
});

describe("request_merge", () => {
  it("a non-reviewer gets an error and the task stays in review", async () => {
    const mine = worker("dev", "review");
    const out = await makeRequestMergeTool(ctxFor({ reviewer: "bob", taskId: mine.id })).run({ task_id: mine.id, summary: "ready" }, runCtx);
    expect(out).toMatch(/^error: /);
    expect(board.task(mine.id)!.status).toBe("review");
  });

  it("the reviewer moves review to approval and the summary is kept", async () => {
    const mine = worker("dev", "review");
    const ctx = ctxFor({ reviewer: "ana", taskId: mine.id });
    const out = await makeRequestMergeTool(ctx).run({ task_id: mine.id, summary: "paddle and test" }, runCtx);
    expect(out).toBe(`merge requested for ${mine.id}`);
    expect(board.task(mine.id)).toMatchObject({ status: "approval", summary: "paddle and test" });
    expect(ctx.onChange).toHaveBeenCalledOnce();
  });

  it("a reviewer cannot pass on a task it does not review", async () => {
    const mine = worker("dev", "review");
    const other = worker("dev", "review");
    const out = await makeRequestMergeTool(ctxFor({ reviewer: "ana", taskId: mine.id })).run({ task_id: other.id, summary: "x" }, runCtx);
    expect(out).toMatch(/^error: /);
    expect(board.task(other.id)!.status).toBe("review");
  });

  it("a task not in review gets the store's error", async () => {
    const mine = worker("dev", "doing");
    const out = await makeRequestMergeTool(ctxFor({ reviewer: "ana", taskId: mine.id })).run({ task_id: mine.id, summary: "x" }, runCtx);
    expect(out).toBe(`error: ${mine.id} cannot move from doing to approval`);
  });
});

describe("ask_player", () => {
  it("blocks the task with the question as its reason and calls onQuestion", async () => {
    const mine = worker("dev", "doing");
    const ctx = ctxFor({ agentId: "dev", role: "worker", taskId: mine.id });
    const out = await makeAskPlayerTool(ctx).run({ question: "Ball speed?", options: ["slow", "fast"] }, runCtx);
    expect(out).toMatch(/^asked the player/);
    const after = board.task(mine.id)!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("Ball speed?");
    expect(ctx.onQuestion).toHaveBeenCalledWith(mine.id, expect.stringContaining("Ball speed?"));
  });

  it("without a task it returns an error", async () => {
    const out = await makeAskPlayerTool(ctxFor({ taskId: undefined })).run({ question: "Which engine?" }, runCtx);
    expect(out).toMatch(/^error: /);
  });
});

describe("create_goal", () => {
  it("is tier 1 and passes the project and text to post", async () => {
    const post = vi.fn(() => ({ ok: true as const, goalId: "g2" }));
    const tool = makeCreateGoalTool(post);
    expect(tool.tier).toBe(1);
    expect(await tool.run({ project: "game", text: "add sound" }, runCtx)).toBe("created g2");
    expect(post).toHaveBeenCalledWith("game", "add sound");
  });

  it("returns the error from post", async () => {
    const tool = makeCreateGoalTool(() => ({ ok: false as const, error: "unknown project" }));
    expect(await tool.run({ project: "nope", text: "x" }, runCtx)).toBe("error: unknown project");
  });
});

describe("propose_plan", () => {
  it("stores the plan as proposed by the boss and calls onChange", async () => {
    const ctx = ctxFor({ role: "boss", agentId: "boss" });
    const tool = makeProposePlanTool(ctx);
    expect(tool.tier).toBe(0);
    expect(await tool.run({ text: "Steps: paddle" }, runCtx)).toBe(`plan posted for ${goalId}. End your turn; the player answers it.`);
    const goal = board.goal(goalId)!;
    expect(goal.plan).toBe("Steps: paddle");
    expect(goal.planState).toBe("proposed");
    expect(goal.planBy).toBe("boss");
    expect(ctx.onChange).toHaveBeenCalledTimes(1);
  });

  it("ends the run once the plan is posted", async () => {
    const endRun = vi.fn();
    await makeProposePlanTool(ctxFor({ role: "boss", agentId: "boss" })).run({ text: "Steps: paddle" }, { ...runCtx, endRun });
    expect(endRun).toHaveBeenCalledOnce();
  });

  it("does not end the run when the plan is refused", async () => {
    board.setGoalStatus(goalId, "active");
    const endRun = vi.fn();
    await makeProposePlanTool(ctxFor({ role: "boss", agentId: "boss" })).run({ text: "Steps: paddle" }, { ...runCtx, endRun });
    expect(endRun).not.toHaveBeenCalled();
  });

  it("on an active goal returns error: and calls no onChange", async () => {
    board.setGoalStatus(goalId, "active");
    const ctx = ctxFor({ role: "boss", agentId: "boss" });
    const out = await makeProposePlanTool(ctx).run({ text: "Steps: paddle" }, runCtx);
    expect(out.startsWith("error:")).toBe(true);
    expect(ctx.onChange).not.toHaveBeenCalled();
  });
});
