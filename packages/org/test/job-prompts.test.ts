import { describe, it, expect } from "vitest";
import { CHAT_RULES, JOB_RULES, planPrompt, tasksPrompt, splitPrompt, workPrompt, reviewPrompt, nudgePrompt } from "../src/job-prompts.js";
import type { Goal, Task } from "@agentcity/safety";

const goal: Goal = { id: "g1", projectId: "game", text: "make pong", status: "active", plan: null, planState: "none", planBy: null, createdAt: "", updatedAt: "" };
const task = (over: Partial<Task> = {}): Task => ({
  id: "t2", goalId: "g1", parentId: "t1", projectId: "game", title: "paddle", description: "move with arrows",
  assignee: "dev", deps: [], status: "doing", branch: null, worktree: null, summary: null, blockedReason: null, checkpoint: null, held: false, heldByParent: false,
  ci: "none", testOutput: null, sendBacks: 0, nudges: 0, testFixes: 0, conflicts: 0, createdBy: "ana",
  createdAt: "", updatedAt: "", ...over,
});
const board: Task[] = [
  task({ id: "t1", parentId: null, title: "pong team", assignee: "ana", status: "doing" }),
  task({ id: "t2", title: "paddle", status: "doing", deps: [] }),
  task({ id: "t3", title: "score", status: "todo", deps: ["t2"], assignee: "qa" }),
];
const members = [{ id: "ana", name: "Ana" }, { id: "dev", name: "Dev" }, { id: "qa", name: "Quinn" }];

describe("JOB_RULES", () => {
  it("has a rule set for each role, every line under 25 words", () => {
    for (const role of ["boss", "manager", "worker"] as const) {
      const lines = JOB_RULES[role].split("\n").filter((l) => l.trim() !== "");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.trim().split(/\s+/).length).toBeLessThan(25);
    }
  });
});

describe("boss and chat rules", () => {
  it("the boss splits the work itself when the team has no manager", () => {
    expect(JOB_RULES.boss).toContain("no manager");
  });

  it("chat rules keep the line limit and tell only leads to use create_goal", () => {
    for (const role of ["boss", "manager", "worker"] as const) {
      for (const line of CHAT_RULES[role].split("\n")) expect(line.trim().split(/\s+/).length).toBeLessThan(25);
    }
    expect(CHAT_RULES.boss).toContain("create_goal");
    expect(CHAT_RULES.worker).not.toContain("create_goal");
  });
});

describe("boss plan rule", () => {
  it("the boss rules mention propose_plan", () => {
    expect(JOB_RULES.boss).toContain("propose_plan");
  });
});

describe("planPrompt, tasksPrompt and splitPrompt", () => {
  it("planPrompt names propose_plan and the three parts", () => {
    const out = planPrompt(goal, members, null, []);
    expect(out).toContain("make pong");
    expect(out).toContain("Quinn");
    expect(out).toContain("propose_plan");
    for (const part of ["Steps", "Teams", "Open questions"]) expect(out).toContain(part);
    expect(out).not.toContain("Your last plan:");
  });

  it("planPrompt with previous plan and notes includes both", () => {
    const out = planPrompt(goal, members, "Steps: paddle", ["add a sound"]);
    expect(out).toContain("Your last plan:");
    expect(out).toContain("Steps: paddle");
    expect(out).toContain("The player asked for changes:");
    expect(out).toContain("add a sound");
  });

  it("tasksPrompt includes the approved plan and create_task", () => {
    const out = tasksPrompt(goal, "Steps: paddle", board, members);
    expect(out).toContain("The player approved this plan:");
    expect(out).toContain("Steps: paddle");
    expect(out).toContain("create_task");
    expect(out).toContain("t2");
    expect(out).toContain("Make one task per real piece of work. A small goal is one task.");
    expect(out).not.toContain("Never make a task only to check another task.");
  });

  it("split holds the team task and its goal", () => {
    const out = splitPrompt(goal, board[0]!, board, members);
    expect(out).toContain("pong team");
    expect(out).toContain("make pong");
    expect(out).toContain("A small task gets one worker task.");
    expect(out).not.toContain("Workers cannot open a browser, so never make a browser check task.");
    expect(out).not.toContain("Each worker task must change files.");
  });
});

describe("workPrompt", () => {
  const base = { worktree: "/home/worktrees/game/t2", branch: "agent/dev/t2", base: "main", answers: ["use blue"], inbox: ["Message from the player: go faster"], continues: false };

  it("tells the worker that its notes may be old and the folder is the truth", () => {
    const out = workPrompt(goal, task(), board, base);
    expect(out).toContain("Your notes may be out of date. Run list_files first. The folder you are in is the task's work folder and holds the project.");
  });

  it("holds the task id, title, worktree, base, answers and inbox", () => {
    const out = workPrompt(goal, task(), board, base);
    expect(out).toContain("t2");
    expect(out).toContain("paddle");
    expect(out).toContain("/home/worktrees/game/t2");
    expect(out).toContain("main");
    expect(out).toContain("use blue");
    expect(out).toContain("Message from the player: go faster");
    expect(out).not.toContain("main..HEAD");
  });

  it("with continues adds the git log of the branch", () => {
    const out = workPrompt(goal, task(), board, { ...base, continues: true });
    expect(out).toContain("git log main..HEAD");
  });

  it("adds the resume note after the answers and inbox", () => {
    expect(workPrompt(goal, task(), board, { ...base, resume: "NOTE" })).toContain("\nNOTE\n");
  });
});

describe("reviewPrompt", () => {
  it("holds PASS and the diff text when the tests pass", () => {
    const out = reviewPrompt(task({ status: "review", summary: "paddle moves" }), "paddle moves", { command: "npm test", pass: true, output: "" }, "+ let speed = 4;");
    expect(out).toContain("paddle moves");
    expect(out).toContain("PASS");
    expect(out).toContain("+ let speed = 4;");
  });

  it("holds FAIL and the test output when the tests fail", () => {
    const out = reviewPrompt(task({ status: "review" }), "x", { command: "npm test", pass: false, output: "expected 4" }, "");
    expect(out).toContain("FAIL");
    expect(out).toContain("expected 4");
  });

  it("cuts the diff to 12000 characters", () => {
    const out = reviewPrompt(task({ status: "review" }), "x", { pass: true }, "a".repeat(20000));
    expect(out).not.toContain("a".repeat(12001));
    expect(out).toContain("a".repeat(12000));
  });
});

describe("nudgePrompt", () => {
  it("names the task, its title and description, and the two allowed statuses", () => {
    const out = nudgePrompt(task({ id: "t2", title: "paddle", description: "move with arrows" }));
    expect(out).toContain("t2");
    expect(out).toContain("paddle");
    expect(out).toContain("move with arrows");
    expect(out).toContain("review");
    expect(out).toContain("blocked");
  });
});
