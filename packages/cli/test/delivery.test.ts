import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyTool, RunResult } from "@agentcity/core";
import { AgentStore } from "@agentcity/org";
import { BoardStore, defaultProjectConfig, openDb, projectDirs, saveProjectConfig } from "@agentcity/safety";
import type { Job } from "../src/job-runner.js";
import { Scheduler } from "../src/scheduler.js";

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

/** Stands in for JobRunner, as in scheduler.test.ts. Runs the script of the job kind, which calls the board tools it was given. */
class FakeJobs {
  calls: Job[] = [];
  scripts: Record<string, Script> = {};
  async run(job: Job, tools: AnyTool[], signal: AbortSignal, inbox: () => string[]): Promise<RunResult> {
    this.calls.push(job);
    const script = this.scripts[`${job.kind}:${job.taskId}`] ?? this.scripts[job.kind];
    const tool = async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`job ${job.kind} has no tool ${name}`);
      return t.run(args, { projectId: job.projectId, agentId: job.agentId, sandboxDir: job.cwd, outboxDir: job.cwd });
    };
    await script?.({ job, inbox, signal, tool });
    return { reason: "done", steps: 1, usage, runId: job.runId ?? "none", answer: "" };
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

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const agent = (id: string, role: "boss" | "manager" | "worker") =>
  new AgentStore(home).create({ id, name: id.toUpperCase(), role, persona: `You are ${id}.`, model: "lmstudio/test" });

/** Writes the project: agents, linked repo, and the `board` key with the test command, as scheduler.test.ts does. */
function project(testCommand: string): void {
  saveProjectConfig(home, { ...defaultProjectConfig("demo"), agents: ["boss", "mgr", "w1", "w2"], workspace: repo });
  const file = projectDirs(home, "demo").config;
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...json, board: { testCommand } }, null, 2));
}

const until = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true), { timeout: 15000, interval: 20 });

/** The boss proposes a plan. The player approves it through answerPlan, as the scheduler tests do. */
const PROPOSE: Script = async (c) => void (await c.tool("propose_plan", { text: "Steps: two teams, the second after the first. Teams: mgr. Open questions: none." }));
/** The boss makes two team tasks. The second depends on the first. */
const TWO_TEAMS: Script = async (c) => {
  await c.tool("create_task", { title: "First", description: "first team work", assignee: "mgr" });
  await c.tool("create_task", { title: "Second", description: "second team work", assignee: "mgr", deps: ["t1"] });
};
/** The manager of a team makes one worker task for it. */
const splitOne = (worker: string): Script => async (c) => void (await c.tool("create_task", { title: `Work ${c.job.taskId}`, description: "write the file", assignee: worker }));
/** A worker writes a file in its worktree and passes the task to review. */
const WORK: Script = async (c) => {
  write(c.job.cwd, `${c.job.taskId}.txt`, `from ${c.job.taskId}\n`);
  await c.tool("update_task", { task_id: c.job.taskId, status: "review", summary: "done" });
};
/** The reviewer passes the task to the player for merge. */
const APPROVE: Script = async (c) => void (await c.tool("request_merge", { task_id: c.job.taskId, summary: "ok" }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-delivery-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-delivery-repo-"));
  sh(repo, "init", "-q", "-b", "main");
  write(repo, "readme.md", "hi\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
  agent("boss", "boss");
  agent("mgr", "manager");
  agent("w1", "worker");
  agent("w2", "worker");
  project('node -e "process.exit(0)"');
  db = openDb(home);
  board = new BoardStore(db);
  fake = new FakeJobs();
  sched = new Scheduler({ home, board, jobs: fake, agents: new AgentStore(home), onChange: () => undefined });
});

afterEach(async () => {
  sched.stop();
  db.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
});

describe("Delivery", () => {
  it("one goal runs from split to merge: two dependent team tasks, tests, review, approval and merge", async () => {
    fake.scripts.plan = PROPOSE;
    fake.scripts.tasks = TWO_TEAMS;
    fake.scripts["split:t1"] = splitOne("w1");
    fake.scripts["split:t2"] = splitOne("w2");
    fake.scripts.work = WORK;
    fake.scripts.review = APPROVE;
    // The second team's worker: the first team's work must already be merged and in its worktree.
    let firstDone: boolean | undefined;
    let firstFileInWorktree: boolean | undefined;
    fake.scripts["work:t4"] = async (c) => {
      firstDone = board.task("t1")!.status === "done";
      firstFileInWorktree = fs.existsSync(path.join(c.job.cwd, "t3.txt"));
      await WORK(c);
    };

    sched.recover();
    const goal = sched.submitGoal("demo", "two dependent teams");
    await sched.whenIdle();
    expect(board.goal(goal.id)).toMatchObject({ status: "planning", planState: "proposed" });

    expect(sched.answerPlan(goal.id, "approve")).toEqual({ ok: true });
    await until(() => board.task("t3")?.status === "approval");

    // The second team splits while the first waits for the player. Its worker does not start yet.
    await until(() => board.task("t4") !== undefined);
    expect(fake.calls.filter((c) => c.kind === "split").map((c) => c.taskId)).toEqual(["t1", "t2"]);
    expect(board.task("t3")!.parentId).toBe("t1");
    expect(board.task("t4")!.parentId).toBe("t2");
    expect(board.task("t2")!.deps).toEqual(["t1"]);
    expect(fake.calls.some((c) => c.kind === "work" && c.taskId === "t4")).toBe(false);
    expect(board.task("t4")!.status).toBe("todo");

    expect(fake.kinds().slice(0, 2)).toEqual(["plan", "tasks"]);
    expect(board.task("t3")!.ci).toBe("pass");
    expect(sched.review("t3", "merge")).toEqual({ ok: true });

    await until(() => board.task("t4")?.status === "approval");
    expect(firstDone).toBe(true);
    expect(firstFileInWorktree).toBe(true);
    expect(board.task("t4")!.ci).toBe("pass");
    expect(fake.calls.filter((c) => c.kind === "review")).toHaveLength(2);

    expect(sched.review("t4", "merge")).toEqual({ ok: true });
    await sched.whenIdle();

    expect(board.goal(goal.id)!.status).toBe("done");
    expect(board.tasks(goal.id).filter((t) => t.status === "blocked")).toEqual([]);
    const baseFiles = sh(repo, "ls-tree", "--name-only", "main").split("\n");
    expect(baseFiles).toEqual(expect.arrayContaining(["t3.txt", "t4.txt"]));
  });
});
