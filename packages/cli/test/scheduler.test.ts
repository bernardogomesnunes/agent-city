import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyTool, RunResult } from "@agentcity/core";
import { AgentStore, nudgePrompt } from "@agentcity/org";
import { BoardStore, defaultProjectConfig, openDb, projectDirs, saveProjectConfig, type Limits } from "@agentcity/safety";
import type { Job } from "../src/job-runner.js";
import { NO_TEAM, Scheduler } from "../src/scheduler.js";

// Lets a test make the file removal of a project fail. Everything else is the real module.
const rm = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/worktrees.js", async (orig) => {
  const m = await orig<typeof import("../src/worktrees.js")>();
  return {
    ...m,
    removeProjectFiles: (...a: Parameters<typeof m.removeProjectFiles>) => {
      if (rm.fail) throw new Error("EBUSY: file locked");
      return m.removeProjectFiles(...a);
    },
  };
});

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

// Each test runs real git commands on temp repos, which is slow on Windows.
vi.setConfig({ testTimeout: 30_000 });

const usage = { inputTokens: 0, outputTokens: 0 };

interface Ctx {
  job: Job;
  inbox: () => string[];
  signal: AbortSignal;
  tool(name: string, args: Record<string, unknown>): Promise<string>;
}
type Script = (c: Ctx) => Promise<void>;

/** Stands in for JobRunner. Runs the script of the job kind, which calls the board tools it was given. */
class FakeJobs {
  calls: Job[] = [];
  scripts: Record<string, Script> = {};
  /** Result reason by job kind. Default `done`. */
  reasons: Record<string, string> = {};
  async run(job: Job, tools: AnyTool[], signal: AbortSignal, inbox: () => string[]): Promise<RunResult> {
    this.calls.push(job);
    const script = this.scripts[`${job.kind}:${job.taskId}`] ?? this.scripts[job.kind];
    const tool = async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`job ${job.kind} has no tool ${name}`);
      return t.run(args, { projectId: job.projectId, agentId: job.agentId, sandboxDir: job.cwd, outboxDir: job.cwd });
    };
    await script?.({ job, inbox, signal, tool });
    return { reason: this.reasons[job.kind] ?? "done", steps: 1, usage, runId: job.runId ?? "none", answer: "" };
  }
  kinds(): string[] {
    return this.calls.map((c) => c.kind);
  }
}

let home: string;
let repo: string;
let db: ReturnType<typeof openDb>;
let board: BoardStore;
let fake: FakeJobs;
let sched: Scheduler;
let changes: string[];

const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const agent = (id: string, role: "boss" | "manager" | "worker") =>
  new AgentStore(home).create({ id, name: id.toUpperCase(), role, persona: `You are ${id}.`, model: "lmstudio/test" });

/**
 * Writes the project: agents list, linked repo, the `board` test command, and `limits`.
 * `maxConcurrent` is the parallel cap, written as limits.parallelJobs.
 */
function project(agents: string[], board?: { maxConcurrent?: number; testCommand?: string }, limits: Partial<Limits> = {}): void {
  const { maxConcurrent, ...rest } = board ?? {};
  const defaults = defaultProjectConfig("demo");
  saveProjectConfig(home, {
    ...defaults, agents, workspace: repo,
    limits: { ...defaults.limits, ...(maxConcurrent === undefined ? {} : { parallelJobs: maxConcurrent }), ...limits },
    ...(board ? { board: rest } : {}),
  });
}

const make = () => new Scheduler({ home, board, jobs: fake, agents: new AgentStore(home), onChange: (p) => changes.push(p) });
const status = (id: string) => board.task(id)!.status;
const until = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true), { timeout: 15000, interval: 20 });

/** The boss proposes a plan. `PLAN` also approves it at once, so the tests that are not about approval go on to the tasks job. */
const PROPOSE: Script = async (c) => void (await c.tool("propose_plan", { text: "Steps: build it. Teams: mgr. Open questions: none." }));
const PLAN: Script = async (c) => {
  await PROPOSE(c);
  board.setPlanState(c.job.goalId, "approved");
};
const TASKS: Script = async (c) => void (await c.tool("create_task", { title: "Team", description: "team work", assignee: "mgr" }));
const approveAll = () => {
  for (const g of board.plansWaiting()) expect(sched.answerPlan(g.id, "approve")).toEqual({ ok: true });
};
const splitTwo = (deps: string[] = []): Script => async (c) => {
  await c.tool("create_task", { title: "A", description: "a", assignee: "w1" });
  await c.tool("create_task", { title: "B", description: "b", assignee: "w2", deps });
};
const WORK: Script = async (c) => {
  write(c.job.cwd, `${c.job.taskId}.txt`, `from ${c.job.taskId}\n`);
  await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "done" });
};
const APPROVE: Script = async (c) => void (await c.tool("request_merge", { task_id: c.job.taskId, summary: "ok" }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sch-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sch-repo-"));
  sh(repo, "init", "-q", "-b", "main");
  write(repo, "readme.md", "hi\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
  agent("boss", "boss");
  agent("mgr", "manager");
  agent("w1", "worker");
  agent("w2", "worker");
  project(["boss", "mgr", "w1", "w2"]);
  db = openDb(home);
  board = new BoardStore(db);
  fake = new FakeJobs();
  changes = [];
  sched = make();
});

afterEach(async () => {
  sched.stop();
  db.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
});

describe("Scheduler", () => {
  it("runs a goal through plan, split, work, tests, review and approval, and holds t3 until t2 merges", async () => {
    project(["boss", "mgr", "w1", "w2"], { testCommand: 'node -e "process.exit(0)"' });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    const goal = sched.submitGoal("demo", "build it");
    expect(goal.status).toBe("planning");
    await sched.whenIdle();

    expect(fake.kinds()).toEqual(["plan", "tasks", "split", "work", "review"]);
    expect(fake.calls[0]!.agentId).toBe("boss");
    expect(fake.calls[2]!.agentId).toBe("mgr");
    expect(fake.calls[3]).toMatchObject({ agentId: "w1", taskId: "t2" });
    expect(fake.calls[4]).toMatchObject({ agentId: "mgr", taskId: "t2" });
    expect(fake.calls[4]!.prompt).toContain("PASS");
    expect(fake.calls[4]!.prompt).toContain("t2.txt");
    const t2 = board.task("t2")!;
    expect(t2.status).toBe("approval");
    expect(t2.ci).toBe("pass");
    expect(t2.branch).toBe("agent/w1/t2");
    expect(sh(repo, "log", "-1", "--format=%an|%s", "agent/w1/t2")).toBe("AgentCity W1|t2: A");
    expect(status("t3")).toBe("todo");
    expect(board.goal(goal.id)!.status).toBe("active");
    expect(board.runs("t2").map((r) => r.kind)).toEqual(["work", "review"]);
    expect(board.runs("t2")[0]!.runId).toBe(fake.calls[3]!.runId);

    expect(sched.review("t2", "merge")).toEqual({ ok: true });
    await sched.whenIdle();
    expect(status("t2")).toBe("done");
    expect(fs.existsSync(t2.worktree!)).toBe(false);
    expect(fake.kinds()).toEqual(["plan", "tasks", "split", "work", "review", "work", "review"]);
    expect(fake.calls[5]).toMatchObject({ agentId: "w2", taskId: "t3" });
    expect(fs.existsSync(path.join(fake.calls[5]!.cwd, "t2.txt"))).toBe(true);
    expect(status("t3")).toBe("approval");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((p) => p === "demo")).toBe(true);
  });

  it("maxConcurrent 1 holds the second ready task while one work job runs", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts["work:t2"] = async (c) => {
      await gate;
      await WORK(c);
    };
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "two jobs");
    await until(() => fake.calls.some((c) => c.kind === "work"));
    await sched.tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.filter((c) => c.kind === "work")).toHaveLength(1);
    expect(status("t3")).toBe("todo");
    open();
    await sched.whenIdle();
    expect(fake.calls.filter((c) => c.kind === "work").map((c) => c.taskId)).toEqual(["t2", "t3"]);
    expect(status("t3")).toBe("approval");
  });

  it("maxConcurrent 2 runs two work jobs together", async () => {
    project(["boss", "mgr", "w1", "w2"], { maxConcurrent: 2 });
    let live = 0;
    let peak = 0;
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts.work = async (c) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 150));
      live--;
      await WORK(c);
    };
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "parallel");
    await sched.whenIdle();
    expect(peak).toBe(2);
  });

  it("parallelJobs 0 has no cap: both work jobs run together", async () => {
    project(["boss", "mgr", "w1", "w2"], { maxConcurrent: 0 });
    let live = 0;
    let peak = 0;
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts.work = async (c) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 150));
      live--;
      await WORK(c);
    };
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "no cap");
    await sched.whenIdle();
    expect(peak).toBe(2);
  });

  it("reminders 0 sends no nudge: a work job that ends in doing with changes goes to review", async () => {
    project(["boss", "mgr", "w1", "w2"], undefined, { reminders: 0 });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async (c) => write(c.job.cwd, "a.txt", "a\n");
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "no reminder");
    await until(() => status("t2") === "approval");
    expect(fake.calls.filter((c) => c.kind === "followup")).toHaveLength(0);
    expect(board.task("t2")!.nudges).toBe(0);
  });

  it("testFixes 0 sends no fix job: a failing test run reaches review with FAIL", async () => {
    project(["boss", "mgr", "w1", "w2"], { testCommand: 'node -e "console.log(\'boom\'); process.exit(1)"' }, { testFixes: 0 });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "no fix");
    await until(() => status("t2") === "approval");
    expect(fake.kinds()).toEqual(["plan", "tasks", "split", "work", "review"]);
    expect(fake.calls[4]!.prompt).toContain("FAIL");
    expect(board.task("t2")!.testFixes).toBe(0);
  });

  it("sendBacks 0 sends no review back: the first verdict goes to approval with the notes", async () => {
    project(["boss", "mgr", "w1", "w2"], undefined, { sendBacks: 0 });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.review = async (c) => void (await c.tool("update_task", { task_id: c.job.taskId, status: "doing", summary: "rename the file" }));
    sched.submitGoal("demo", "no send back");
    await until(() => status("t2") === "approval");
    expect(fake.calls.filter((c) => c.kind === "followup")).toHaveLength(0);
    expect(board.task("t2")!.summary).toContain("Review notes after 0 send-backs: rename the file");
  });

  it("conflicts 0 blocks the task at its first merge conflict", async () => {
    project(["boss", "mgr", "w1", "w2"], undefined, { conflicts: 0 });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts.work = async (c) => {
      write(c.job.cwd, "shared.txt", `${c.job.taskId}\n`);
      await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "done" });
    };
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "no conflict retry");
    await until(() => status("t2") === "approval" && status("t3") === "approval");
    expect(sched.review("t2", "merge")).toEqual({ ok: true });
    expect(sched.review("t3", "merge").ok).toBe(false);
    expect(status("t3")).toBe("blocked");
    expect(fake.kinds().filter((k) => k === "followup")).toHaveLength(0);
  });

  it("nudges a work job that ends in doing once, then moves it to review when files changed", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async (c) => write(c.job.cwd, "a.txt", "a\n");
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "nudge");
    await until(() => status("t2") === "approval");
    const follow = fake.calls.filter((c) => c.kind === "followup");
    expect(follow).toHaveLength(1);
    expect(follow[0]!.prompt).toBe(nudgePrompt(board.task("t2")!));
    expect(follow[0]!.agentId).toBe("w1");
    expect(board.task("t2")!.nudges).toBe(1);
  });

  it("blocks a task whose second end has no file changes", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async () => undefined;
    sched.submitGoal("demo", "nothing");
    await sched.whenIdle();
    const t2 = board.task("t2")!;
    expect(t2.status).toBe("blocked");
    expect(t2.blockedReason).toBe("stopped without changes");
    expect(fake.calls.filter((c) => c.kind === "followup")).toHaveLength(1);
    expect(fake.kinds()).not.toContain("review");
  });

  it("a budget_job stop blocks the task with the job copy", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async () => undefined;
    fake.reasons.work = "budget_job";
    sched.submitGoal("demo", "too big");
    await sched.whenIdle();
    expect(status("t2")).toBe("blocked");
    expect(board.task("t2")!.blockedReason).toBe("stopped: this job used its 200,000 tokens. Answer to continue with a new job.");
  });

  it("a budget_day stop blocks the task with the day copy", async () => {
    saveProjectConfig(home, { ...defaultProjectConfig("demo"), agents: ["boss", "mgr", "w1", "w2"], workspace: repo, budget: { jobTokens: 200000, dayUsd: 2.5 } });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async () => undefined;
    fake.reasons.work = "budget_day";
    sched.submitGoal("demo", "too costly");
    await sched.whenIdle();
    expect(board.task("t2")!.blockedReason).toBe("stopped: the project spent its $2.5 for today.");
  });

  it("blocks a task that marks review with no file changes", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async (c) => void (await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "trust me" }));
    sched.submitGoal("demo", "empty review");
    await sched.whenIdle();
    expect(status("t2")).toBe("blocked");
    expect(board.task("t2")!.blockedReason).toBe("no changes");
  });

  it("a failing test command sends the task back once, then reaches review with FAIL", async () => {
    project(["boss", "mgr", "w1", "w2"], { testCommand: 'node -e "console.log(\'boom\'); process.exit(1)"' });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.followup = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "tests fail");
    await until(() => status("t2") === "approval");
    expect(fake.kinds()).toEqual(["plan", "tasks", "split", "work", "followup", "review"]);
    expect(fake.calls[4]!.prompt).toContain("boom");
    expect(fake.calls[5]!.prompt).toContain("FAIL");
    const t2 = board.task("t2")!;
    expect(t2.ci).toBe("fail");
    expect(t2.testFixes).toBe(1);
    expect(t2.testOutput).toContain("boom");
  });

  it("the third manager send-back moves the task to approval with the notes", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.followup = async (c) => void (await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "again" }));
    fake.scripts.review = async (c) => void (await c.tool("update_task", { task_id: c.job.taskId, status: "doing", summary: "rename the file" }));
    sched.submitGoal("demo", "picky manager");
    await until(() => status("t2") === "approval");
    expect(fake.calls.filter((c) => c.kind === "review")).toHaveLength(3);
    expect(fake.calls.filter((c) => c.kind === "followup")).toHaveLength(2);
    expect(fake.calls[4]!.agentId).toBe("mgr");
    const followup = fake.calls.find((c) => c.kind === "followup")!;
    expect(followup.prompt).toContain("rename the file");
    const t2 = board.task("t2")!;
    expect(t2.sendBacks).toBe(2);
    expect(t2.summary).toContain("rename the file");
  });

  it("a review job that ends without a verdict moves the task to approval", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.review = async () => undefined;
    sched.submitGoal("demo", "silent reviewer");
    await until(() => status("t2") === "approval");
  });

  it("message while a job runs reaches the inbox", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let seen: string[] = [];
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async (c) => {
      await gate;
      seen = c.inbox();
      await WORK(c);
    };
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "talk");
    await until(() => sched.runningTask("w1") === "t2");
    sched.message("t2", "use tabs");
    open();
    await sched.whenIdle();
    expect(seen).toEqual(["use tabs"]);
    expect(sched.runningTask("w1")).toBeUndefined();
  });

  it("message with no running job starts a followup", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    fake.scripts.followup = WORK;
    sched.submitGoal("demo", "talk later");
    await sched.whenIdle();
    expect(status("t2")).toBe("approval");
    sched.message("t2", "also add a title");
    await sched.whenIdle();
    const follow = fake.calls.filter((c) => c.kind === "followup");
    expect(follow).toHaveLength(1);
    expect(follow[0]!.agentId).toBe("w1");
    expect(follow[0]!.prompt).toContain("also add a title");
    expect(status("t2")).toBe("approval");
  });

  it("a review job runs in the task's worktree, not the project root", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    let reviewCwd = "";
    fake.scripts.review = async (c) => {
      reviewCwd = c.job.cwd;
      await APPROVE(c);
    };
    sched.recover();
    sched.submitGoal("demo", "review folder");
    await until(() => status("t2") === "approval");
    expect(reviewCwd).toBe(board.task("t2")!.worktree);
    expect(reviewCwd).not.toBe(repo);
  });

  it("recover turns doing into todo and the next work prompt mentions git log", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async (c) => {
      write(c.job.cwd, "half.txt", "half\n");
      await new Promise(() => undefined);
    };
    sched.submitGoal("demo", "crash");
    await until(() => fake.calls.some((c) => c.kind === "work"));
    const wt = board.task("t2")!.worktree!;
    expect(status("t2")).toBe("doing");

    const again = new FakeJobs();
    again.scripts.work = WORK;
    again.scripts.review = APPROVE;
    const next = new Scheduler({ home, board, jobs: again, agents: new AgentStore(home), onChange: () => undefined });
    next.recover();
    expect(status("t2")).toBe("todo");
    await next.tick();
    await next.whenIdle();
    const work = again.calls.find((c) => c.kind === "work")!;
    expect(work.prompt).toContain("git log");
    expect(work.cwd).toBe(wt);
    expect(fs.existsSync(path.join(wt, "half.txt"))).toBe(true);
    expect(status("t2")).toBe("approval");
    next.stop();
  });

  it("recover moves a task left in review to approval", () => {
    const goal = board.createGoal("demo", "g");
    const team = board.createTask({ goalId: goal.id, title: "T", description: "", assignee: "mgr", createdBy: "boss" });
    const t = board.createTask({ goalId: goal.id, parentId: team.id, title: "A", description: "", assignee: "w1", createdBy: "mgr" });
    board.setStatus(t.id, "doing");
    board.setStatus(t.id, "review");
    sched.recover();
    expect(status(t.id)).toBe("approval");
  });

  it("merge with uncommitted changes in the project root returns an error and keeps approval", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "dirty root");
    await until(() => status("t2") === "approval");
    write(repo, "scratch.txt", "player edit\n");
    const r = sched.review("t2", "merge");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("uncommitted");
    expect(status("t2")).toBe("approval");
    fs.rmSync(path.join(repo, "scratch.txt"));
    expect(sched.review("t2", "merge")).toEqual({ ok: true });
    expect(status("t2")).toBe("done");
  });

  it("review refuses a task that is not in approval", () => {
    const goal = board.createGoal("demo", "g");
    const team = board.createTask({ goalId: goal.id, title: "T", description: "", assignee: "mgr", createdBy: "boss" });
    const r = sched.review(team.id, "merge");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("approval") });
    expect(sched.review("t99", "merge").ok).toBe(false);
  });

  it("a conflict block with conflicts 0 says no retries set", async () => {
    project(["boss", "mgr", "w1", "w2"], undefined, { conflicts: 0 });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts.work = async (c) => {
      write(c.job.cwd, "shared.txt", `${c.job.taskId}\n`);
      await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "done" });
    };
    fake.scripts.review = APPROVE;
    sched.recover();
    sched.submitGoal("demo", "no retries set");
    await until(() => status("t2") === "approval" && status("t3") === "approval");
    expect(sched.review("t2", "merge")).toEqual({ ok: true });
    expect(sched.review("t3", "merge").ok).toBe(false);
    expect(board.task("t3")!.blockedReason).toBe("merge conflict with main, no retries set");
  });

  it("a conflict block above one retry names the real retry count", async () => {
    project(["boss", "mgr", "w1", "w2"], undefined, { conflicts: 3 });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts.work = async (c) => {
      write(c.job.cwd, "shared.txt", `${c.job.taskId}\n`);
      await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "done" });
    };
    fake.scripts.review = APPROVE;
    sched.recover();
    sched.submitGoal("demo", "three retries");
    await until(() => status("t2") === "approval" && status("t3") === "approval");
    expect(sched.review("t2", "merge")).toEqual({ ok: true });
    board.update("t3", { conflicts: 3 });
    expect(sched.review("t3", "merge").ok).toBe(false);
    expect(board.task("t3")!.blockedReason).toBe("merge conflict with main again after 3 retries");
  });

  it("a merge conflict sends the task back once, then blocks it", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts.work = async (c) => {
      write(c.job.cwd, "shared.txt", `${c.job.taskId}\n`);
      await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "done" });
    };
    fake.scripts.followup = async (c) => void (await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "resolved" }));
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "conflict");
    await until(() => status("t2") === "approval" && status("t3") === "approval");
    expect(sched.review("t2", "merge")).toEqual({ ok: true });
    const first = sched.review("t3", "merge");
    expect(first.ok).toBe(false);
    expect(board.task("t3")!.conflicts).toBe(1);
    await until(() => status("t3") === "approval");
    const sentBack = fake.calls.filter((c) => c.kind === "followup").at(-1)!;
    expect(sentBack.prompt).toContain("git merge main");
    const second = sched.review("t3", "merge");
    expect(second.ok).toBe(false);
    expect(status("t3")).toBe("blocked");
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });

  it("changes sends the text to the worker and reject cancels the task and drops its worktree", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts.work = WORK;
    fake.scripts.followup = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "player decides");
    await until(() => status("t2") === "approval" && status("t3") === "approval");
    expect(sched.review("t2", "changes", "make it blue")).toEqual({ ok: true });
    await until(() => status("t2") === "approval");
    const follow = fake.calls.filter((c) => c.kind === "followup");
    expect(follow[0]!.prompt).toContain("make it blue");

    const wt = board.task("t3")!.worktree!;
    expect(sched.review("t3", "reject")).toEqual({ ok: true });
    expect(status("t3")).toBe("cancelled");
    expect(fs.existsSync(wt)).toBe(false);
    expect(sh(repo, "branch", "--list", "agent/w2/t3")).toContain("agent/w2/t3");
  });

  it("ask_player blocks the task and answer starts a followup with the answer", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async (c) => void (await c.tool("ask_player", { question: "Which color?", options: ["red", "blue"] }));
    fake.scripts.followup = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "ask");
    await sched.whenIdle();
    expect(status("t2")).toBe("blocked");
    expect(board.task("t2")!.blockedReason).toContain("Which color?");
    expect(fake.calls.filter((c) => c.kind === "followup")).toHaveLength(0);
    sched.answer("t2", "blue");
    await sched.whenIdle();
    const follow = fake.calls.filter((c) => c.kind === "followup");
    expect(follow).toHaveLength(1);
    expect(follow[0]!.prompt).toContain("blue");
    expect(status("t2")).toBe("approval");
  });

  it("cancel aborts the running job and retry puts the task back to todo", async () => {
    let aborted = false;
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts["work:t2"] = async (c) => {
      write(c.job.cwd, "x.txt", "x\n");
      await new Promise<void>((r) => c.signal.addEventListener("abort", () => ((aborted = true), r())));
    };
    sched.submitGoal("demo", "cancel me");
    await until(() => sched.runningTask("w1") === "t2");
    const wt = board.task("t2")!.worktree!;
    sched.action("t2", "cancel");
    await sched.whenIdle();
    expect(aborted).toBe(true);
    expect(status("t2")).toBe("cancelled");
    expect(fs.existsSync(wt)).toBe(false);
    expect(fake.calls.filter((c) => c.kind === "followup")).toHaveLength(0);

    fake.scripts["work:t2"] = WORK;
    fake.scripts.review = APPROVE;
    sched.action("t2", "retry");
    await sched.whenIdle();
    expect(status("t2")).toBe("approval");
  });

  it("a job waits while its agent has a chat turn, and starts on the next tick after it", async () => {
    let chatting = true;
    const freed = vi.fn();
    const s = new Scheduler({
      home, board, jobs: fake, agents: new AgentStore(home), onChange: () => undefined,
      chatting: () => chatting, onAgentFree: freed,
    });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts["work:t2"] = WORK;
    fake.scripts.review = APPROVE;
    s.submitGoal("demo", "wait for chat");
    await s.tick();
    expect(fake.kinds()).toEqual([]);
    chatting = false;
    await s.tick();
    await s.whenIdle();
    expect(fake.kinds()).toContain("plan");
    expect(freed).toHaveBeenCalledWith("boss");
    s.stop();
  });

  it("cancel aborts the running job's signal; the job runner then denies its approvals", async () => {
    const aborted = vi.fn();
    const s = new Scheduler({ home, board, jobs: fake, agents: new AgentStore(home), onChange: () => undefined });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts["work:t2"] = async (c) => void (await new Promise<void>((r) => c.signal.addEventListener("abort", () => (aborted(), r()))));
    s.submitGoal("demo", "deny");
    await until(() => s.runningTask("w1") === "t2");
    s.action("t2", "cancel");
    await s.whenIdle();
    expect(aborted).toHaveBeenCalled();
    s.stop();
  });

  it("after stop a job that ends starts no further job", async () => {
    const s = new Scheduler({ home, board, jobs: fake, agents: new AgentStore(home), onChange: () => undefined });
    fake.scripts.plan = async (c) => {
      await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
      await PLAN(c);
    };
    s.submitGoal("demo", "stop me");
    await until(() => fake.kinds().includes("plan"));
    s.stop();
    await s.whenIdle();
    await s.tick();
    expect(fake.kinds()).toEqual(["plan"]);
  });

  it("a plan job without propose_plan fails the goal after its second turn", async () => {
    sched.recover();
    fake.scripts.plan = async () => undefined;
    const goal = sched.submitGoal("demo", "nothing to plan");
    await sched.whenIdle();
    expect(board.goal(goal.id)!.status).toBe("failed");
    expect(fake.kinds()).toEqual(["plan", "plan"]);
  });

  it("a plan job that ends without propose_plan gets one more turn with the original prompt, which posts the plan", async () => {
    sched.recover();
    let turn = 0;
    fake.scripts.plan = async (c) => {
      turn++;
      if (turn === 2) await PROPOSE(c);
    };
    const goal = sched.submitGoal("demo", "build it");
    await sched.whenIdle();
    expect(fake.kinds()).toEqual(["plan", "plan"]);
    expect(board.goal(goal.id)).toMatchObject({ status: "planning", planState: "proposed" });
    expect(fake.calls[0]!.prompt).not.toContain("Your last turn ended");
    expect(fake.calls[1]!.prompt).toContain('"build it"');
    expect(fake.calls[1]!.prompt).toContain("Your last turn ended without propose_plan. Call it now.");
  });

  it("a tasks job that ends without create_task gets one more turn, which creates the team task", async () => {
    sched.recover();
    let turn = 0;
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = async (c) => {
      turn++;
      if (turn === 2) await TASKS(c);
    };
    fake.scripts.split = splitTwo();
    const goal = sched.submitGoal("demo", "split the plan");
    await sched.whenIdle();
    expect(fake.kinds().slice(0, 4)).toEqual(["plan", "tasks", "tasks", "split"]);
    expect(board.tasks(goal.id).filter((t) => t.parentId === null).map((t) => t.title)).toEqual(["Team"]);
    expect(fake.calls[2]!.prompt).toContain("Your last turn ended without create_task. Call it now.");
    expect(fake.calls[1]!.prompt).not.toContain("Your last turn ended");
  });

  it("a tasks job that ends without create_task twice fails the goal", async () => {
    sched.recover();
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = async () => undefined;
    const goal = sched.submitGoal("demo", "no tasks");
    await sched.whenIdle();
    expect(fake.kinds()).toEqual(["plan", "tasks", "tasks"]);
    expect(board.goal(goal.id)!.status).toBe("failed");
  });

  it("a split job that ends without create_task gets one more turn, which creates the tasks", async () => {
    sched.recover();
    let turn = 0;
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = async (c) => {
      turn++;
      if (turn === 2) await splitTwo()(c);
    };
    sched.submitGoal("demo", "split it");
    await sched.whenIdle();
    expect(fake.kinds().slice(0, 4)).toEqual(["plan", "tasks", "split", "split"]);
    expect(board.children("t1").map((t) => t.title)).toEqual(["A", "B"]);
    expect(fake.calls[3]!.prompt).toContain("Your last turn ended without create_task. Call it now.");
  });

  it("a split job paused before it ends gets no second turn", async () => {
    sched.recover();
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = async () => {
      expect(sched.action("t1", "pause")).toEqual({ ok: true });
    };
    sched.submitGoal("demo", "pause me");
    await sched.whenIdle();
    expect(fake.kinds().filter((k) => k === "split")).toHaveLength(1);
  });

  it("a tasks job stopped by the job budget gets no second turn", async () => {
    sched.recover();
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = async () => undefined;
    fake.reasons.tasks = "budget_job";
    sched.submitGoal("demo", "over budget");
    await sched.whenIdle();
    expect(fake.kinds()).toEqual(["plan", "tasks"]);
  });

  it("a new goal runs a plan job and waits at proposed", async () => {
    fake.scripts.plan = PROPOSE;
    const goal = sched.submitGoal("demo", "build it");
    await sched.whenIdle();
    await sched.tick();
    await sched.whenIdle();
    expect(fake.kinds()).toEqual(["plan"]);
    expect(board.goal(goal.id)).toMatchObject({ status: "planning", planState: "proposed" });
    expect(board.tasks(goal.id)).toHaveLength(0);
  });

  it("approve runs tasks then split", async () => {
    fake.scripts.plan = PROPOSE;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    const goal = sched.submitGoal("demo", "build it");
    await sched.whenIdle();
    approveAll();
    await sched.whenIdle();
    expect(fake.kinds().slice(0, 3)).toEqual(["plan", "tasks", "split"]);
    expect(fake.calls[1]!.prompt).toContain("Steps: build it.");
    expect(board.goal(goal.id)).toMatchObject({ status: "active", planState: "approved" });
  });

  it("changes reruns plan with the note", async () => {
    fake.scripts.plan = PROPOSE;
    const goal = sched.submitGoal("demo", "build it");
    await sched.whenIdle();
    expect(sched.answerPlan(goal.id, "changes", "use fewer steps")).toEqual({ ok: true });
    await sched.whenIdle();
    expect(fake.kinds()).toEqual(["plan", "plan"]);
    expect(fake.calls[1]!.prompt).toContain("use fewer steps");
    expect(fake.calls[1]!.prompt).toContain("Steps: build it.");
    expect(board.goal(goal.id)!.planState).toBe("proposed");
  });

  it("changes without text is refused", async () => {
    fake.scripts.plan = PROPOSE;
    const goal = sched.submitGoal("demo", "build it");
    await sched.whenIdle();
    expect(sched.answerPlan(goal.id, "changes")).toEqual({ ok: false, error: "say what to change" });
    expect(sched.answerPlan(goal.id, "changes", "  ")).toEqual({ ok: false, error: "say what to change" });
    expect(board.goal(goal.id)!.planState).toBe("proposed");
  });

  it("reject cancels the goal", async () => {
    fake.scripts.plan = PROPOSE;
    const goal = sched.submitGoal("demo", "build it");
    await sched.whenIdle();
    expect(sched.answerPlan(goal.id, "reject")).toEqual({ ok: true });
    await sched.whenIdle();
    expect(board.goal(goal.id)!.status).toBe("cancelled");
    expect(fake.kinds()).toEqual(["plan"]);
  });

  it("changes sent while the plan job still runs reruns the plan with the note", async () => {
    let first = true;
    fake.scripts.plan = async (c) => {
      await PROPOSE(c);
      if (!first) return;
      first = false;
      // The player answers while the boss is still in its turn.
      expect(sched.answerPlan(c.job.goalId, "changes", "add a menu")).toEqual({ ok: true });
    };
    const goal = sched.submitGoal("demo", "build it");
    await until(() => fake.kinds().length === 2);
    await sched.whenIdle();
    expect(board.goal(goal.id)).toMatchObject({ status: "planning", planState: "proposed" });
    expect(fake.calls[1]!.prompt).toContain("add a menu");
    expect(board.takeGoalNotes(goal.id)).toEqual([]);
  });

  it("a plan job that dies keeps the player's note for the rerun", async () => {
    fake.scripts.plan = PROPOSE;
    const goal = sched.submitGoal("demo", "build it");
    await sched.whenIdle();
    let calls = 0;
    fake.scripts.plan = async (c) => {
      calls++;
      if (calls <= 2) throw new Error("provider down");
      await PROPOSE(c);
    };
    expect(sched.answerPlan(goal.id, "changes", "add a menu")).toEqual({ ok: true });
    await sched.whenIdle();
    expect(calls).toBe(2);
    // The failed job failed the goal; a restart puts it back to planning with its note.
    board.setGoalStatus(goal.id, "planning");
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    const last = fake.calls.at(-1)!;
    expect(last.kind).toBe("plan");
    expect(last.prompt).toContain("add a menu");
  });

  it("a plan job stopped by the day cap keeps the goal planning and does not rerun today", async () => {
    fake.scripts.plan = async () => undefined;
    fake.reasons.plan = "budget_day";
    const goal = sched.submitGoal("demo", "build it");
    await sched.whenIdle();
    await sched.tick();
    await sched.whenIdle();
    expect(fake.kinds()).toEqual(["plan"]);
    expect(board.goal(goal.id)).toMatchObject({ status: "planning", planState: "none" });
  });

  it("answerPlan on a goal that is not proposed is refused", async () => {
    const goal = board.createGoal("demo", "idle goal");
    expect(sched.answerPlan(goal.id, "approve")).toEqual({ ok: false, error: "plan is not waiting" });
    expect(sched.answerPlan("g999", "approve")).toEqual({ ok: false, error: "plan is not waiting" });
  });

  it("approve with no managers makes one boss team task", async () => {
    project(["boss", "w1", "w2"]);
    fake.scripts.plan = PROPOSE;
    const goal = sched.submitGoal("demo", "small project");
    await sched.whenIdle();
    expect(board.tasks(goal.id)).toHaveLength(0);
    approveAll();
    await until(() => board.tasks(goal.id).length === 1);
    expect(board.tasks(goal.id)[0]).toMatchObject({ assignee: "boss", parentId: null });
    expect(board.goal(goal.id)!.status).toBe("active");
  });

  it("recover reruns plan once", async () => {
    fake.scripts.plan = PROPOSE;
    board.createGoal("demo", "crashed before the plan");
    sched.recover();
    await sched.tick();
    await sched.tick();
    await sched.whenIdle();
    expect(fake.kinds()).toEqual(["plan"]);
  });

  it("a split job that creates no task blocks the team task", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = async () => undefined;
    sched.submitGoal("demo", "nothing to split");
    await sched.whenIdle();
    expect(fake.kinds().filter((k) => k === "split")).toHaveLength(2);
    expect(status("t1")).toBe("blocked");
    expect(board.task("t1")!.blockedReason).toContain("no tasks");
  });

  it("a split whose every create_task is rejected blocks the team task with the rejection", async () => {
    const goal = board.createGoal("demo", "refused split");
    const team = board.createTask({ goalId: goal.id, title: "Team", description: "team work", assignee: "mgr", createdBy: "boss" });
    fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "nobody" }));
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(board.task(team.id)!.status).toBe("blocked");
    expect(board.task(team.id)!.blockedReason).toBe("split created no tasks: error: assignee must be one of w1, w2");
  });

  it("a new split forgets the rejection of a split that was paused", async () => {
    const goal = board.createGoal("demo", "paused rejection");
    const team = board.createTask({ goalId: goal.id, title: "Team", description: "team work", assignee: "mgr", createdBy: "boss" });
    fake.scripts.split = async (c) => {
      await c.tool("create_task", { title: "A", description: "a", assignee: "nobody" });
      fake.scripts.split = async () => undefined;
      expect(sched.action(team.id, "pause")).toEqual({ ok: true });
    };
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(sched.action(team.id, "resume")).toEqual({ ok: true });
    await sched.tick();
    await sched.whenIdle();
    expect(fake.kinds().filter((k) => k === "split")).toHaveLength(3);
    expect(status(team.id)).toBe("blocked");
    expect(board.task(team.id)!.blockedReason).toBe("split created no tasks");
  });

  it("a project with no manager lets the boss split the goal and review the work", async () => {
    project(["boss", "w1", "w2"]);
    fake.scripts.plan = PLAN;
    fake.scripts.split = async (c) => {
      await c.tool("create_task", { title: "A", description: "a", assignee: "w1" });
    };
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "small project");
    await sched.whenIdle();
    expect(fake.kinds()).toEqual(["plan", "split", "work", "review"]);
    expect(fake.calls[0]!.agentId).toBe("boss");
    expect(fake.calls[1]!.agentId).toBe("boss");
    expect(fake.calls[3]!.agentId).toBe("boss");
    expect(status("t2")).toBe("approval");
  });

  it("an unassigned ready task goes to a free member of the manager's team", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = async (c) => {
      expect(c.job.taskId).toBe("t1");
      await c.tool("create_task", { title: "A", description: "a" });
    };
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "unassigned");
    await sched.whenIdle();
    const work = fake.calls.find((c) => c.kind === "work")!;
    expect(["w1", "w2"]).toContain(work.agentId);
    expect(board.task("t2")!.assignee).toBe(work.agentId);
  });

  it("a manager with no workers blocks the team task without a model call", async () => {
    project(["boss", "mgr"]);
    const goal = board.createGoal("demo", "build it");
    const team = board.createTask({ goalId: goal.id, title: "Team", description: "team work", assignee: "mgr", createdBy: "boss" });
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(board.task(team.id)!.status).toBe("blocked");
    expect(board.task(team.id)!.blockedReason).toMatch(/^no workers:/);
    expect(board.task(team.id)!.blockedReason).toContain("demo");
    expect(fake.calls).toHaveLength(0);
  });

  it("a boss lead with no workers blocks the team task without a model call, and a granted worker restarts it", async () => {
    project(["boss"]);
    const goal = board.createGoal("demo", "boss alone");
    const team = board.createTask({ goalId: goal.id, title: "Team", description: "team work", assignee: "boss", createdBy: "boss" });
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(status(team.id)).toBe("blocked");
    expect(board.task(team.id)!.blockedReason).toMatch(/^no workers:/);
    expect(fake.calls).toHaveLength(0);

    agent("ada", "worker");
    project(["boss", "ada"]);
    fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "ada" }));
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    await sched.tick();
    await sched.whenIdle();
    expect(status(team.id)).not.toBe("blocked");
    expect(board.task(team.id)!.blockedReason).toBeNull();
    expect(fake.calls.some((c) => c.kind === "split" && c.taskId === team.id)).toBe(true);
  });

  it("granting a worker restarts a task blocked for no team", async () => {
    agent("ada", "worker");
    project(["boss", "mgr"]);
    const goal = board.createGoal("demo", "grant a worker");
    const team = board.createTask({ goalId: goal.id, title: "Team", description: "team work", assignee: "mgr", createdBy: "boss" });
    fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "ada" }));
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(status(team.id)).toBe("blocked");
    expect(board.task(team.id)!.blockedReason).toMatch(new RegExp(`^${NO_TEAM}`));

    project(["boss", "mgr", "ada"]);
    await sched.tick();
    await sched.whenIdle();
    expect(status(team.id)).not.toBe("blocked");
    expect(board.task(team.id)!.blockedReason).toBeNull();
    expect(fake.calls.some((c) => c.kind === "split" && c.taskId === team.id)).toBe(true);
  });

  it("a held task blocked for no team stays blocked and held after a grant", async () => {
    agent("ada", "worker");
    project(["boss", "mgr"]);
    const goal = board.createGoal("demo", "held grant");
    const team = board.createTask({ goalId: goal.id, title: "Team", description: "team work", assignee: "mgr", createdBy: "boss" });
    board.setStatus(team.id, "blocked", { force: true });
    board.update(team.id, { blockedReason: `${NO_TEAM} grant a worker to demo in Configure` });
    board.setHeld(team.id, true);
    sched.recover();

    project(["boss", "mgr", "ada"]);
    await sched.tick();
    await sched.whenIdle();
    expect(status(team.id)).toBe("blocked");
    expect(board.task(team.id)!.held).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("a task blocked for another reason stays blocked", async () => {
    project(["boss", "mgr"]);
    const goal = board.createGoal("demo", "merge conflict");
    const team = board.createTask({ goalId: goal.id, title: "Team", description: "team work", assignee: "mgr", createdBy: "boss" });
    board.setStatus(team.id, "blocked", { force: true });
    board.update(team.id, { blockedReason: "merge conflict" });
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(status(team.id)).toBe("blocked");
    expect(fake.calls).toHaveLength(0);
  });

  it("a team task whose dependency is blocked starts no split job until the dependency is retried", async () => {
    const goal = board.createGoal("demo", "dependent teams");
    const dep = board.createTask({ goalId: goal.id, title: "First", description: "first", assignee: "mgr", createdBy: "boss" });
    board.setStatus(dep.id, "blocked", { force: true });
    board.update(dep.id, { blockedReason: "merge conflict" });
    const team = board.createTask({ goalId: goal.id, title: "Second", description: "second", assignee: "mgr", createdBy: "boss", deps: [dep.id] });
    fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "w1" }));
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(fake.calls.filter((c) => c.taskId === team.id)).toHaveLength(0);
    expect(status(team.id)).toBe("todo");

    expect(sched.action(dep.id, "retry")).toEqual({ ok: true });
    await sched.tick();
    await sched.whenIdle();
    expect(fake.calls.filter((c) => c.kind === "split" && c.taskId === team.id)).toHaveLength(1);
  });

  it("a dependent of a cancelled team task is blocked with a card, and retry removes the dep and runs it", async () => {
    const goal = board.createGoal("demo", "cancel a dep");
    const first = board.createTask({ goalId: goal.id, title: "First", description: "first", assignee: "mgr", createdBy: "boss" });
    const second = board.createTask({ goalId: goal.id, title: "Second", description: "second", assignee: "mgr", createdBy: "boss", deps: [first.id] });
    expect(sched.action(first.id, "cancel")).toEqual({ ok: true });
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(status(second.id)).toBe("blocked");
    expect(board.task(second.id)!.blockedReason).toBe('dependency "First" was cancelled');
    expect(board.waitingTasks().map((t) => t.id)).toContain(second.id);
    expect(fake.calls).toHaveLength(0);

    fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "w1" }));
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    expect(sched.action(second.id, "retry")).toEqual({ ok: true });
    await until(() => board.children(second.id).some((t) => t.status === "approval"));
    expect(board.task(second.id)!.deps).toEqual([]);
    expect(board.task(second.id)!.blockedReason).toBeNull();
  });

  it("a held task is not blocked for a cancelled dependency until it is resumed", async () => {
    const goal = board.createGoal("demo", "held dep");
    const first = board.createTask({ goalId: goal.id, title: "First", description: "first", assignee: "mgr", createdBy: "boss" });
    const second = board.createTask({ goalId: goal.id, title: "Second", description: "second", assignee: "mgr", createdBy: "boss", deps: [first.id] });
    board.setHeld(second.id, true);
    expect(sched.action(first.id, "cancel")).toEqual({ ok: true });
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(status(second.id)).toBe("todo");
    expect(board.task(second.id)!.blockedReason).toBeNull();
    expect(board.waitingTasks().map((t) => t.id)).not.toContain(second.id);

    expect(sched.action(second.id, "resume")).toEqual({ ok: true });
    await sched.tick();
    await sched.whenIdle();
    expect(status(second.id)).toBe("blocked");
    expect(board.task(second.id)!.blockedReason).toBe('dependency "First" was cancelled');
  });

  it("one retry frees every worker of the team blocked for the same cancelled dep", async () => {
    const goal = board.createGoal("demo", "two blocked workers");
    const first = board.createTask({ goalId: goal.id, title: "First", description: "first", assignee: "mgr", createdBy: "boss" });
    const second = board.createTask({ goalId: goal.id, title: "Second", description: "second", assignee: "mgr", createdBy: "boss", deps: [first.id] });
    const a = board.createTask({ goalId: goal.id, parentId: second.id, title: "A", description: "a", assignee: "w1", createdBy: "mgr" });
    const b = board.createTask({ goalId: goal.id, parentId: second.id, title: "B", description: "b", assignee: "w2", createdBy: "mgr" });
    expect(sched.action(first.id, "cancel")).toEqual({ ok: true });
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(status(a.id)).toBe("blocked");
    expect(status(b.id)).toBe("blocked");

    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    expect(sched.action(a.id, "retry")).toEqual({ ok: true });
    await until(() => status(a.id) === "approval" && status(b.id) === "approval");
    expect(board.task(second.id)!.deps).toEqual([]);
  });

  it("a dependent of a done team task is not blocked", async () => {
    const goal = board.createGoal("demo", "done dep");
    const first = board.createTask({ goalId: goal.id, title: "First", description: "first", assignee: "mgr", createdBy: "boss" });
    board.setStatus(first.id, "done", { force: true });
    const second = board.createTask({ goalId: goal.id, title: "Second", description: "second", assignee: "mgr", createdBy: "boss", deps: [first.id] });
    fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "w1" }));
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(board.task(second.id)!.blockedReason).toBeNull();
    expect(status(second.id)).not.toBe("blocked");
    expect(fake.kinds()).toContain("split");
  });

  it("retry on a worker of a team with a cancelled dep removes that dep from the team and runs the worker", async () => {
    const goal = board.createGoal("demo", "cancel a team dep");
    const first = board.createTask({ goalId: goal.id, title: "First", description: "first", assignee: "mgr", createdBy: "boss" });
    const second = board.createTask({ goalId: goal.id, title: "Second", description: "second", assignee: "mgr", createdBy: "boss", deps: [first.id] });
    const w = board.createTask({ goalId: goal.id, parentId: second.id, title: "W", description: "w", assignee: "w1", createdBy: "mgr" });
    expect(sched.action(first.id, "cancel")).toEqual({ ok: true });
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(status(second.id)).toBe("blocked");
    expect(status(w.id)).toBe("blocked");
    expect(board.task(w.id)!.blockedReason).toBe('dependency "First" was cancelled');

    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    expect(sched.action(w.id, "retry")).toEqual({ ok: true });
    await until(() => status(w.id) === "approval");
    expect(board.task(second.id)!.deps).toEqual([]);
    expect(status(second.id)).not.toBe("blocked");
  });

  it("a manager gets the project's workers when none share its building", async () => {
    new AgentStore(home).create({ id: "ada", name: "ADA", role: "worker", persona: "You are ada.", model: "lmstudio/test", building: "visual" });
    project(["boss", "mgr", "ada"]);
    const goal = board.createGoal("demo", "split it");
    const team = board.createTask({ goalId: goal.id, title: "Team", description: "team work", assignee: "mgr", createdBy: "boss" });
    let made = "";
    fake.scripts.split = async (c) => {
      made = await c.tool("create_task", { title: "A", description: "a", assignee: "ada" });
    };
    sched.recover();
    await sched.tick();
    await sched.whenIdle();
    expect(made).not.toMatch(/^error/);
    expect(board.tasks(goal.id).find((t) => t.parentId === team.id)?.assignee).toBe("ada");
  });

  it("the finished goal is done after every task merges", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "w1" }));
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    const goal = sched.submitGoal("demo", "finish");
    await sched.whenIdle();
    expect(sched.review("t2", "merge")).toEqual({ ok: true });
    await sched.whenIdle();
    expect(board.goal(goal.id)!.status).toBe("done");
    expect(status("t1")).toBe("done");
  });

  it("pause aborts the running work job, returns the task to todo with its worktree, and starts nothing until resume", async () => {
    let runs = 0;
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts["work:t2"] = async (c) => {
      if (++runs > 1) return WORK(c);
      write(c.job.cwd, "x.txt", "x\n");
      await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
    };
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "pause me");
    await until(() => sched.runningTask("w1") === "t2");
    expect(sched.pause("demo")).toEqual({ ok: true });
    await sched.whenIdle();
    await until(() => status("t2") === "todo");
    expect(board.task("t2")!.worktree).not.toBeNull();
    expect(board.paused()).toEqual(["demo"]);
    const before = fake.calls.length;
    await sched.tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls).toHaveLength(before);
    expect(changes.length).toBeGreaterThan(0);

    expect(sched.resume("demo")).toEqual({ ok: true });
    await until(() => status("t2") === "approval");
    expect(fake.calls.filter((c) => c.kind === "work" && c.taskId === "t2")).toHaveLength(2);
  });

  it("pause during a split job lets it finish, starts no work until resume, then work starts", async () => {
    let aborted: boolean | undefined;
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = async (c) => {
      await new Promise((r) => setTimeout(r, 150));
      aborted = c.signal.aborted;
      await splitTwo()(c);
    };
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "pause split");
    await until(() => fake.calls.some((c) => c.kind === "split"));
    sched.pause("demo");
    await until(() => board.task("t3") !== undefined);
    await sched.whenIdle();
    expect(aborted).toBe(false);
    expect(board.task("t2")).toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.filter((c) => c.kind === "work")).toHaveLength(0);
    sched.resume("demo");
    await until(() => fake.calls.some((c) => c.kind === "work"));
    await until(() => status("t2") === "approval" && status("t3") === "approval");
  });

  it("after resume a second ready task can start, so pause released the slot", async () => {
    let first = true;
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    fake.scripts["work:t2"] = async (c) => {
      if (!first) return WORK(c);
      first = false;
      await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
    };
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "two tasks");
    await until(() => sched.runningTask("w1") === "t2");
    sched.pause("demo");
    await sched.whenIdle();
    sched.resume("demo");
    await until(() => status("t2") === "approval" && status("t3") === "approval");
    expect(fake.calls.filter((c) => c.kind === "work").map((c) => c.taskId)).toEqual(["t2", "t2", "t3"]);
  });

  it("pause during a review job moves the task to approval", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = WORK;
    fake.scripts.review = async (c) => {
      await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
    };
    sched.submitGoal("demo", "pause review");
    await until(() => fake.calls.some((c) => c.kind === "review"));
    sched.pause("demo");
    await sched.whenIdle();
    expect(status("t2")).toBe("approval");
  });

  it("an answer in a paused project waits for resume", async () => {
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo(["t2"]);
    fake.scripts.work = async (c) => void (await c.tool("ask_player", { question: "Which color?", options: ["red", "blue"] }));
    fake.scripts.followup = WORK;
    fake.scripts.review = APPROVE;
    sched.submitGoal("demo", "ask");
    await sched.whenIdle();
    expect(status("t2")).toBe("blocked");
    sched.pause("demo");
    sched.answer("t2", "blue");
    await sched.tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.kinds()).not.toContain("followup");
    sched.resume("demo");
    await until(() => fake.kinds().includes("followup"));
    await until(() => status("t2") === "approval");
  });

  it("a plan answer in a paused project starts no tasks job until resume", async () => {
    fake.scripts.plan = PROPOSE;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = splitTwo();
    sched.submitGoal("demo", "plan it");
    await sched.whenIdle();
    sched.pause("demo");
    approveAll();
    await sched.tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.kinds()).toEqual(["plan"]);
    sched.resume("demo");
    await until(() => fake.kinds().includes("tasks"));
  });

  it("pauseAll and resumeAll pause and resume every project", () => {
    sched.pauseAll();
    expect(board.paused()).toEqual(["demo"]);
    sched.resumeAll();
    expect(board.paused()).toEqual([]);
  });

  it("a new scheduler on the same board keeps the pause", async () => {
    fake.scripts.plan = PROPOSE;
    sched.pause("demo");
    const other = make();
    try {
      other.submitGoal("demo", "paused");
      await other.tick();
      await new Promise((r) => setTimeout(r, 100));
      expect(fake.calls).toHaveLength(0);
      other.resume("demo");
      await until(() => fake.kinds().includes("plan"));
    } finally {
      other.stop();
    }
  });

  it("pause of an unknown project returns No project <id>", () => {
    expect(sched.pause("nope")).toEqual({ ok: false, error: "No project nope" });
    expect(sched.resume("nope")).toEqual({ ok: false, error: "No project nope" });
    expect(board.paused()).toEqual([]);
  });

  it("a pause during a task's test run keeps its slot flow: after resume its review runs and the next work job starts", async () => {
    project(["boss", "mgr", "w1", "w2"], { testCommand: 'node -e "setTimeout(()=>{},1500)"' });
    fake.scripts.plan = PLAN;
    fake.scripts.tasks = TASKS;
    fake.scripts.split = async (c) => {
      await c.tool("create_task", { title: "A", description: "a", assignee: "w1" });
      await c.tool("create_task", { title: "B", description: "b", assignee: "w2" });
      await c.tool("create_task", { title: "C", description: "c", assignee: "w1" });
    };
    fake.scripts.work = WORK;
    fake.scripts.review = async (c) => {
      if (c.job.taskId === "t2") await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
      else await APPROVE(c);
    };
    sched.submitGoal("demo", "pause in tests");
    await until(() => fake.calls.some((c) => c.kind === "review" && c.taskId === "t2") && board.task("t3")!.ci === "running");
    sched.pause("demo");
    await sched.whenIdle();
    expect(status("t2")).toBe("approval");
    await until(() => board.task("t3")!.ci !== "running");
    expect(status("t3")).toBe("review");
    expect(fake.calls.filter((c) => c.kind === "review" && c.taskId === "t3")).toHaveLength(0);

    sched.resume("demo");
    await until(() => status("t3") === "approval" && status("t4") === "approval");
    expect(fake.calls.some((c) => c.kind === "work" && c.taskId === "t4")).toBe(true);
  });

  describe("per-task pause", () => {
    it("pause aborts the task's job and holds it", async () => {
      let runs = 0;
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = splitTwo();
      fake.scripts["work:t2"] = async (c) => {
        if (++runs > 1) return WORK(c);
        write(c.job.cwd, "x.txt", "x\n");
        await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
      };
      fake.scripts.work = WORK;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "pause one");
      await until(() => sched.runningTask("w1") === "t2");
      expect(sched.action("t2", "pause")).toEqual({ ok: true });
      await until(() => status("t2") === "todo");
      expect(board.task("t2")!.held).toBe(true);
      expect(board.task("t2")!.worktree).not.toBeNull();
      expect(board.paused()).toEqual([]);
      await until(() => status("t3") === "approval");
      await sched.whenIdle();
      expect(fake.calls.filter((c) => c.kind === "work" && c.taskId === "t2")).toHaveLength(1);
      expect(status("t2")).toBe("todo");
    });

    it("pausing a task whose work job is queued frees its slot, so the next task starts", async () => {
      project(["boss", "mgr", "w1", "w2"], { maxConcurrent: 1 });
      let chatting = true;
      sched.stop();
      sched = new Scheduler({
        home, board, jobs: fake, agents: new AgentStore(home), onChange: (p) => changes.push(p),
        chatting: (id) => chatting && id === "w1" && board.task("t2")?.status === "doing",
      });
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => {
        await splitTwo()(c);
      };
      fake.scripts.work = WORK;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "pause queued");
      await until(() => board.task("t2")?.status === "doing");
      await sched.whenIdle();
      expect(sched.runningTask("w1")).toBeUndefined();
      expect(sched.action("t2", "pause")).toEqual({ ok: true });
      chatting = false;
      await sched.tick();
      await until(() => status("t3") === "approval");
      expect(status("t2")).toBe("todo");
      expect(board.task("t2")!.held).toBe(true);
      expect(fake.calls.filter((c) => c.kind === "work" && c.taskId === "t2")).toHaveLength(0);
    });

    it("pausing a task during a test run that fails frees its slot and returns it to todo", async () => {
      project(["boss", "mgr", "w1", "w2"], { maxConcurrent: 1, testCommand: 'node -e "setTimeout(()=>process.exit(1),800)"' });
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = splitTwo();
      fake.scripts.work = WORK;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "pause in failing tests");
      await until(() => board.task("t2")?.ci === "running");
      expect(sched.action("t2", "pause")).toEqual({ ok: true });
      await until(() => status("t2") === "todo");
      await until(() => fake.calls.some((c) => c.kind === "work" && c.taskId === "t3"));
      expect(board.task("t2")!.held).toBe(true);
      expect(board.task("t2")!.worktree).not.toBeNull();
      expect(fake.calls.filter((c) => c.kind === "work" && c.taskId === "t2")).toHaveLength(1);
      await sched.whenIdle();
    });

    it("pausing a team task holds its worker children and aborts their jobs, and resume releases them", async () => {
      project(["boss", "mgr", "w1", "w2"], { maxConcurrent: 2 });
      const runs: Record<string, number> = { t2: 0, t3: 0 };
      const hang: Script = async (c) => {
        if (++runs[c.job.taskId!]! > 1) return WORK(c);
        write(c.job.cwd, "x.txt", "x\n");
        await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
      };
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = splitTwo();
      fake.scripts["work:t2"] = hang;
      fake.scripts["work:t3"] = hang;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "pause team");
      await until(() => sched.runningTask("w1") === "t2" && sched.runningTask("w2") === "t3");
      expect(sched.action("t1", "pause")).toEqual({ ok: true });
      await until(() => status("t2") === "todo" && status("t3") === "todo");
      await sched.whenIdle();
      expect([board.task("t1")!.held, board.task("t2")!.held, board.task("t3")!.held]).toEqual([true, true, true]);
      expect(fake.calls.filter((c) => c.kind === "work")).toHaveLength(2);
      expect(sched.action("t1", "resume")).toEqual({ ok: true });
      expect([board.task("t1")!.held, board.task("t2")!.held, board.task("t3")!.held]).toEqual([false, false, false]);
      await until(() => status("t2") === "approval" && status("t3") === "approval");
    });

    it("resuming a team task leaves a child the player paused alone still held", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => {
        await splitTwo(["t2"])(c);
        // The player paused t2 alone, before the team task is paused.
        board.setHeld("t2", true);
      };
      fake.scripts.work = WORK;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "own pause");
      await until(() => board.task("t3") !== undefined);
      sched.action("t1", "pause");
      await sched.whenIdle();
      sched.action("t1", "resume");
      expect([board.task("t1")!.held, board.task("t2")!.held, board.task("t3")!.held]).toEqual([false, true, false]);
      await sched.tick();
      await new Promise((r) => setTimeout(r, 100));
      expect(status("t2")).toBe("todo");
      expect(fake.calls.filter((c) => c.kind === "work")).toHaveLength(0);
    });

    it("pausing a team task aborts its running split job, and a child it creates afterwards starts held", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => {
        await new Promise<void>((r) => c.signal.addEventListener("abort", () => r()));
        await c.tool("create_task", { title: "A", description: "a", assignee: "w1" });
      };
      fake.scripts.work = WORK;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "pause split");
      await until(() => fake.kinds().includes("split"));
      expect(sched.action("t1", "pause")).toEqual({ ok: true });
      await until(() => board.task("t2") !== undefined);
      await sched.whenIdle();
      expect(board.task("t2")!.held).toBe(true);
      expect(fake.calls.filter((c) => c.kind === "work")).toHaveLength(0);
      sched.action("t1", "resume");
      expect(board.task("t2")!.held).toBe(false);
      await until(() => status("t2") === "approval");
    });

    it("pausing a team task does not hold a child that is cancelled", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => {
        await splitTwo(["t2"])(c);
        board.setHeld("t2", true);
      };
      sched.submitGoal("demo", "cancelled child");
      await until(() => board.task("t3") !== undefined);
      await sched.whenIdle();
      expect(sched.action("t3", "cancel")).toEqual({ ok: true });
      expect(status("t3")).toBe("cancelled");
      sched.action("t1", "pause");
      expect(board.task("t3")!.held).toBe(false);
    });

    it("tick skips a held task", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => {
        await splitTwo()(c);
        board.setHeld("t2", true);
      };
      fake.scripts.work = WORK;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "hold first");
      await until(() => board.task("t3") !== undefined);
      await sched.whenIdle();
      await sched.tick();
      await new Promise((r) => setTimeout(r, 100));
      expect(fake.calls.filter((c) => c.kind === "work" && c.taskId === "t2")).toHaveLength(0);
      expect(status("t2")).toBe("todo");
      await until(() => status("t3") === "approval");
    });

    it("resume clears held and ticks", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = splitTwo(["t2"]);
      fake.scripts.work = WORK;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "hold then go");
      await until(() => board.task("t3") !== undefined);
      sched.action("t2", "pause");
      await sched.whenIdle();
      expect(sched.action("t2", "resume")).toEqual({ ok: true });
      expect(board.task("t2")!.held).toBe(false);
      await until(() => status("t2") === "approval");
    });

    it("pause on an idle task holds it", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = splitTwo(["t2"]);
      sched.submitGoal("demo", "idle");
      await until(() => board.task("t3") !== undefined);
      expect(sched.action("t3", "pause")).toEqual({ ok: true });
      expect(board.task("t3")!.held).toBe(true);
    });

    it("project resume keeps held tasks held", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => {
        await splitTwo()(c);
        board.setHeld("t2", true);
      };
      fake.scripts.work = WORK;
      fake.scripts.review = APPROVE;
      sched.submitGoal("demo", "project resume");
      await until(() => board.task("t3") !== undefined);
      await sched.whenIdle();
      sched.pause("demo");
      sched.resume("demo");
      await sched.tick();
      await new Promise((r) => setTimeout(r, 100));
      expect(board.task("t2")!.held).toBe(true);
      expect(fake.calls.filter((c) => c.kind === "work" && c.taskId === "t2")).toHaveLength(0);
      await until(() => status("t3") === "approval");
    });
  });

  describe("forget", () => {
    afterEach(() => {
      rm.fail = false;
    });

    it("a file error resumes a project that was not paused and returns the error text", async () => {
      board.createGoal("demo", "a goal");
      rm.fail = true;
      expect(await sched.forget("demo")).toEqual({ ok: false, error: "EBUSY: file locked" });
      expect(board.paused()).toEqual([]);
      expect(board.goals("demo")).toHaveLength(1);
    });

    it("waits while a task of the project runs its tests, then removes", async () => {
      const goal = board.createGoal("demo", "a goal");
      const t = board.createTask({ goalId: goal.id, title: "T", description: "d", assignee: "w1", createdBy: "mgr" });
      board.update(t.id, { ci: "running" });
      let done = false;
      const p = sched.forget("demo").then((r) => ((done = true), r));
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false);
      expect(fs.existsSync(projectDirs(home, "demo").config)).toBe(true);
      board.update(t.id, { ci: "pass" });
      expect(await p).toMatchObject({ ok: true });
      expect(fs.existsSync(projectDirs(home, "demo").config)).toBe(false);
    });

    it("answers stop the runs first when the tests outlast the 10 s wait, and resumes the project", async () => {
      const goal = board.createGoal("demo", "a goal");
      const t = board.createTask({ goalId: goal.id, title: "T", description: "d", assignee: "w1", createdBy: "mgr" });
      board.update(t.id, { ci: "running" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const p = sched.forget("demo");
        await vi.advanceTimersByTimeAsync(10_500);
        expect(await p).toEqual({ ok: false, error: "stop the runs first" });
      } finally {
        vi.useRealTimers();
      }
      expect(board.paused()).toEqual([]);
      expect(fs.existsSync(projectDirs(home, "demo").config)).toBe(true);
    });

    it("a second remove of the same project answers already removing, and a resume answers removing", async () => {
      const goal = board.createGoal("demo", "a goal");
      const t = board.createTask({ goalId: goal.id, title: "T", description: "d", assignee: "w1", createdBy: "mgr" });
      board.update(t.id, { ci: "running" });
      const first = sched.forget("demo");
      await new Promise((r) => setTimeout(r, 250));
      expect(await sched.forget("demo")).toEqual({ ok: false, error: "already removing demo" });
      expect(sched.resume("demo")).toEqual({ ok: false, error: "removing" });
      expect(board.paused()).toEqual(["demo"]);
      board.update(t.id, { ci: "pass" });
      expect(await first).toMatchObject({ ok: true });
    });

    it("a remove that failed can be tried again", async () => {
      board.createGoal("demo", "a goal");
      rm.fail = true;
      expect(await sched.forget("demo")).toMatchObject({ ok: false });
      rm.fail = false;
      expect(await sched.forget("demo")).toMatchObject({ ok: true });
    });

    it("aborts the chat turns of the project before it removes the folders", async () => {
      board.createGoal("demo", "a goal");
      let turn = true;
      const calls: string[] = [];
      sched.stop();
      sched = new Scheduler({
        home, board, jobs: fake, agents: new AgentStore(home), onChange: (p) => changes.push(p),
        chatBusy: () => turn,
        abortChats: (p) => {
          calls.push(`abort ${p} config=${fs.existsSync(projectDirs(home, "demo").config)}`);
          turn = false;
        },
      });
      expect(await sched.forget("demo")).toMatchObject({ ok: true });
      expect(calls).toEqual(["abort demo config=true"]);
      expect(fs.existsSync(projectDirs(home, "demo").config)).toBe(false);
    });

    it("a file error leaves a project that was paused before still paused", async () => {
      board.createGoal("demo", "a goal");
      sched.pause("demo");
      rm.fail = true;
      expect(await sched.forget("demo")).toEqual({ ok: false, error: "EBUSY: file locked" });
      expect(board.paused()).toEqual(["demo"]);
    });
  });

  describe("checkpoint, resume note and rollback", () => {
    const wtOf = () => board.task("t2")!.worktree!;
    const subjects = () => sh(wtOf(), "log", "--format=%s").split("\n");
    const toolRow = { id: 1, ts: "2026-11-04T00:00:00Z", projectId: "demo", agentId: "w1", type: "tool.requested", payload: { call: { name: "write_file", args: { path: "a.txt" } } }, usd: 0, runId: "r1", parentRunId: null };

    /** A single task t2 for w1. Its first work job writes the file and ends `aborted`, so the task blocks. */
    async function blockedAfter(file: string): Promise<void> {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "w1" }));
      fake.reasons.work = "aborted";
      fake.scripts.work = async (c) => write(c.job.cwd, file, "x\n");
      sched.submitGoal("demo", "roll back");
      await until(() => status("t2") === "blocked");
      await sched.whenIdle();
    }

    it("a work job stores a checkpoint after committing what the worktree had", async () => {
      await blockedAfter("a.txt");
      expect(board.task("t2")!.checkpoint).toBe(sh(repo, "rev-parse", "main"));
      fake.reasons.work = "done";
      fake.scripts.work = WORK;
      expect(sched.action("t2", "retry")).toEqual({ ok: true });
      await sched.whenIdle();
      const checkpoint = board.task("t2")!.checkpoint!;
      expect(sh(wtOf(), "log", "-1", "--format=%s", checkpoint)).toBe("t2: checkpoint");
      expect(sh(wtOf(), "log", "-1", "--format=%an", checkpoint)).toBe("AgentCity checkpoint");
      expect(sh(wtOf(), "show", "--name-only", "--format=", checkpoint)).toBe("a.txt");
    });

    it("a checkpoint commit leaves protected paths uncommitted", async () => {
      await blockedAfter(".env");
      write(wtOf(), "a.txt", "A\n");
      fake.reasons.work = "done";
      fake.scripts.work = WORK;
      sched.action("t2", "retry");
      await sched.whenIdle();
      const checkpoint = board.task("t2")!.checkpoint!;
      expect(sh(wtOf(), "show", "--name-only", "--format=", checkpoint)).toBe("a.txt");
      expect(fs.existsSync(path.join(wtOf(), ".env"))).toBe(true);
    });

    it("the work prompt after a stopped run carries the resume note", async () => {
      const rows: string[] = [];
      sched.stop();
      sched = new Scheduler({ home, board, jobs: fake, agents: new AgentStore(home), onChange: (p) => changes.push(p), runRows: (id) => (rows.push(id), [toolRow]) });
      await blockedAfter("a.txt");
      const firstRun = board.runs("t2").at(-1)!.runId;
      fake.reasons.work = "done";
      fake.scripts.work = WORK;
      sched.action("t2", "retry");
      await sched.whenIdle();
      expect(rows).toEqual([firstRun]);
      const prompt = fake.calls.filter((c) => c.kind === "work").at(-1)!.prompt;
      expect(prompt).toContain("stopped (the city stopped)");
      expect(prompt).toContain("write_file a.txt");
    });

    it("rollback resets the worktree to the checkpoint and sets the task to todo", async () => {
      sched.stop();
      sched = new Scheduler({ home, board, jobs: fake, agents: new AgentStore(home), onChange: (p) => changes.push(p), runRows: () => [toolRow] });
      await blockedAfter("b.txt");
      expect(fs.existsSync(path.join(wtOf(), "b.txt"))).toBe(true);
      const checkpoint = board.task("t2")!.checkpoint!;
      // hold the task in todo so the test sees the state before the next job starts
      board.setPaused("demo", true);
      board.update("t2", { nudges: 2, testFixes: 1, sendBacks: 1, conflicts: 1 });
      expect(sched.action("t2", "rollback")).toEqual({ ok: true });
      const reset = board.task("t2")!;
      expect([reset.nudges, reset.testFixes, reset.sendBacks, reset.conflicts]).toEqual([0, 0, 0, 0]);
      expect(fs.existsSync(path.join(wtOf(), "b.txt"))).toBe(false);
      expect(sh(wtOf(), "rev-parse", "HEAD")).toBe(checkpoint);
      expect(status("t2")).toBe("todo");
      expect(board.task("t2")!.blockedReason).toBeNull();
      fake.reasons.work = "done";
      fake.scripts.work = WORK;
      sched.resume("demo");
      await sched.whenIdle();
      const prompt = fake.calls.filter((c) => c.kind === "work").at(-1)!.prompt;
      expect(prompt).not.toContain("Your last run");
      expect(subjects()).not.toContain("t2: checkpoint");
    });

    it("rollback of a task in approval sets it to todo", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "w1" }));
      fake.scripts.work = WORK;
      sched.submitGoal("demo", "approval");
      await until(() => status("t2") === "approval");
      await sched.whenIdle();
      board.setPaused("demo", true);
      expect(sched.action("t2", "rollback")).toEqual({ ok: true });
      expect(status("t2")).toBe("todo");
      expect(fs.existsSync(path.join(wtOf(), "t2.txt"))).toBe(false);
    });

    it("rollback keeps an untracked protected file and reactivates a failed goal", async () => {
      await blockedAfter("b.txt");
      write(wtOf(), ".env", "KEY=1\n");
      board.setGoalStatus(board.task("t2")!.goalId, "failed");
      board.setPaused("demo", true);
      expect(sched.action("t2", "rollback")).toEqual({ ok: true });
      expect(fs.existsSync(path.join(wtOf(), ".env"))).toBe(true);
      expect(fs.existsSync(path.join(wtOf(), "b.txt"))).toBe(false);
      expect(board.goal(board.task("t2")!.goalId)!.status).toBe("active");
    });

    it("a throw from runRows drops the note and the job still runs", async () => {
      const lines: string[] = [];
      sched.stop();
      sched = new Scheduler({ home, board, jobs: fake, agents: new AgentStore(home), onChange: () => {}, log: (l) => lines.push(l), runRows: () => { throw new Error("boom"); } });
      await blockedAfter("a.txt");
      fake.reasons.work = "done";
      fake.scripts.work = WORK;
      sched.action("t2", "retry");
      await sched.whenIdle();
      expect(status("t2")).toBe("approval");
      expect(lines.some((l) => l.includes("resume note") && l.includes("boom"))).toBe(true);
    });

    it("rollback of a task with a queued item says to stop it first", async () => {
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "w1" }));
      fake.scripts.work = WORK;
      sched.submitGoal("demo", "queued");
      await until(() => status("t2") === "approval");
      await sched.whenIdle();
      board.setPaused("demo", true);
      sched.message("t2", "more");
      board.setStatus("t2", "approval", { force: true });
      expect(sched.action("t2", "rollback")).toEqual({ ok: false, error: "stop the task first" });
    });

    it("rollback with an unreadable project.json is refused and keeps an untracked .env", async () => {
      await blockedAfter("b.txt");
      write(wtOf(), ".env", "KEY=1\n");
      board.setPaused("demo", true);
      fs.writeFileSync(projectDirs(home, "demo").config, "{ not json");
      const r = sched.action("t2", "rollback");
      expect(r.ok).toBe(false);
      expect(fs.existsSync(path.join(wtOf(), ".env"))).toBe(true);
      expect(fs.existsSync(path.join(wtOf(), "b.txt"))).toBe(true);
      expect(status("t2")).toBe("blocked");
    });

    it("rollback errors", async () => {
      let during: unknown;
      fake.scripts.plan = PLAN;
      fake.scripts.tasks = TASKS;
      fake.scripts.split = async (c) => void (await c.tool("create_task", { title: "A", description: "a", assignee: "w1" }));
      fake.scripts.work = async (c) => {
        during = sched.action("t2", "rollback");
        write(c.job.cwd, "t2.txt", "x\n");
        await c.tool("update_task", { task_id: "t2", status: "review", summary: "done" });
      };
      sched.submitGoal("demo", "errors");
      await until(() => status("t2") === "approval");
      await sched.whenIdle();
      board.setPaused("demo", true);
      expect(during).toEqual({ ok: false, error: "stop the task first" });

      board.update("t2", { checkpoint: null });
      expect(sched.action("t2", "rollback")).toEqual({ ok: false, error: "no checkpoint yet" });
      board.update("t2", { checkpoint: "0123456789abcdef0123456789abcdef01234567" });
      expect(sched.action("t2", "rollback")).toEqual({ ok: false, error: "checkpoint is gone" });
      expect(status("t2")).toBe("approval");
    });
  });
});
