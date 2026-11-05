// Modeled on agentcraft foreman/src/agents/team.ts (MIT, blendi-remade/agentcraft).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AnyTool, RunResult } from "@agentcity/core";
import {
  makeAskPlayerTool, makeCreateTaskTool, makeProposePlanTool, makeRequestMergeTool, makeUpdateTaskTool,
  nudgePrompt, planPrompt, reviewPrompt, splitPrompt, tasksPrompt, workPrompt,
  type AgentProfile, type AgentStore, type BoardToolCtx, type Member,
} from "@agentcity/org";
import { BoardError, dayKey, defaultProjectConfig, loadProjectConfig, type ActionRow, type BoardStore, type Goal, type Limits, type ProjectConfig, type RunKind, type Task } from "@agentcity/safety";
import { diffText, taskDiff } from "./diff.js";
import type { Job, JobRunner } from "./job-runner.js";
import { baseBranch, branchExists, gitChanges, isGitRepo, workDir } from "./workspace.js";
import { resumeNote } from "./task-log.js";
import { changedFiles, commitAll, commitExists, ensureRepo, headSha, mergeTask, openWorktree, removeProjectFiles, removeWorktree, resetTo, runTests, testCommand, worktreePath, type RemovedFiles } from "./worktrees.js";

export interface SchedulerDeps {
  home: string;
  board: BoardStore;
  /** Only `run` is used, so tests inject a fake that calls the board tools. */
  jobs: Pick<JobRunner, "run">;
  agents: AgentStore;
  /** Called after every change a project's board view may show. */
  onChange(projectId: string): void;
  now?: () => Date;
  log?: (line: string) => void;
  /** Whether the agent has a chat turn running or waiting. Its board jobs wait until it ends. */
  chatting?(agentId: string): boolean;
  /** A board job of the agent ended. Its waiting chat messages can run. */
  onAgentFree?(agentId: string): void;
  /** The logged actions of one run, for the resume note. */
  runRows?(runId: string): ActionRow[];
  /** Whether a run outside the scheduler (an old agent tree or a terminal run) holds the project. */
  projectBusy?(projectId: string): boolean;
  /** Whether a chat turn of a session in the project runs. */
  chatBusy?(projectId: string): boolean;
  /** Aborts the chat turns of the sessions in the project. */
  abortChats?(projectId: string): void;
}

/** What a job does. `kind` is the run kind, `mode` picks the tools and the folder, so a followup keeps the mode of the job it follows. */
type Mode = "plan" | "split" | "work" | "review";

interface Item {
  agentId: string;
  projectId: string;
  goalId: string;
  taskId?: string;
  kind: Job["kind"];
  mode: Mode;
  /** Unset for plan, tasks, split and the first work job: those prompts are built when the job starts. */
  prompt?: string;
  /** Plan job: the id of the newest player note in its prompt. Notes up to it are cleared once a plan is posted. */
  notesUpTo?: number;
  /** Extra turns this job has used. A plan, tasks or split job that ends without its result gets one more turn, so tries is 1 on that turn. */
  tries?: number;
}

interface Running {
  item: Item;
  taskId?: string;
  controller: AbortController;
  inbox: string[];
  startedAt: Date;
  /** Why the run was aborted: the player cancelled the task, the scheduler stopped, or the player paused the project. */
  stop?: "cancel" | "stop" | "pause";
  /** Set when the job's second turn is queued. Its plan or split flag stays held until that turn ends. */
  retried?: boolean;
}

const TICK_MS = 5000;
/** Prefix of the blocked reason of a team task whose manager has no workers. */
export const NO_TEAM = "no workers:";
/** `forget` waits this long for the project's jobs to end, polling every FORGET_STEP_MS. */
const FORGET_WAIT_MS = 10_000;
const FORGET_STEP_MS = 100;
/** Result reasons that mean the model simply ended its turn or ran out of steps. Anything else is a failed run. */
const SOFT_REASONS: ReadonlySet<string> = new Set(["done", "max_steps"]);
/** The board tool a plan, tasks or split job must call before it ends. Other kinds have no result to miss. */
const RESULT_TOOL: Partial<Record<Job["kind"], string>> = { plan: "propose_plan", tasks: "create_task", split: "create_task" };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Runs goals as tasks. The board holds the state; this class decides which job runs next.
 * Each job is one `jobs.run` call. Jobs of one agent run in the order they were queued.
 * Plan, split and review jobs run one at a time per project. Work jobs are capped by `limits.parallelJobs`.
 */
export class Scheduler {
  private readonly queue: Item[] = [];
  private readonly running = new Map<string, Running>();
  /** Work jobs in flight, per project: a worker task keeps its slot from start until it reaches review, blocked or cancelled. */
  private readonly holds = new Map<string, Set<string>>();
  private readonly planning = new Set<string>();
  private readonly splitting = new Set<string>();
  /** The last create_task refusal of each split job, by team task. afterSplit reads it when the split creates nothing. */
  private readonly rejected = new Map<string, string>();
  /** Goals whose plan or tasks job hit the project's day cap, with that day. They wait for the next day. */
  private readonly dayStopped = new Map<string, string>();
  private readonly chains = new Set<Promise<void>>();
  private readonly known = new Set<string>();
  /** Projects `forget` is deleting. A second delete or a resume of one is refused. */
  private readonly removing = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  /** Set by `stop`. A stopped scheduler starts no job, so a job that ends after the stop leaves the board as it is. */
  private stopped = false;

  constructor(private readonly d: SchedulerDeps) {}

  // ---------------------------------------------------------------- public

  submitGoal(projectId: string, text: string): Goal {
    const goal = this.d.board.createGoal(projectId, text);
    this.known.add(projectId);
    this.changed(projectId);
    void this.tick();
    return goal;
  }

  /** Starts every job that may start now. Runs after each job end, task change and 5 second timer. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    for (const project of [...this.known]) {
      try {
        this.tickProject(project);
      } catch (e) {
        this.log(`scheduler: ${project}: ${errorText(e)}`);
      }
    }
    this.pump();
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  /** Stops the timer, aborts every running job. Each aborted run denies its own waiting approvals. Tasks keep their state for `recover`. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const r of this.running.values()) {
      r.stop ??= "stop";
      r.controller.abort();
    }
    this.queue.length = 0;
  }

  /** Resolves when no job runs and no job is being finished. For tests and a clean shutdown. */
  async whenIdle(): Promise<void> {
    while (this.chains.size > 0) await Promise.allSettled([...this.chains]);
  }

  /** The task the agent's running job works on. */
  runningTask(agentId: string): string | undefined {
    return this.running.get(agentId)?.taskId;
  }

  /** A player message for the agent working on the task. */
  message(taskId: string, text: string): void {
    const task = this.d.board.task(taskId);
    if (!task) return;
    const run = [...this.running.values()].find((r) => r.taskId === taskId);
    if (run) {
      run.inbox.push(text);
      this.changed(task.projectId);
      return;
    }
    const agent = task.assignee;
    const queued = this.queue.some((q) => q.taskId === taskId);
    // A message to a task that has not started, is blocked or is finished waits for the next job.
    const live = task.status === "doing" || task.status === "approval";
    if (!agent || task.parentId === null || queued || !live) {
      this.hold(taskId, text);
      return;
    }
    if (task.status === "approval") {
      this.d.board.setStatus(taskId, "doing");
      this.d.board.rollup(task.goalId);
    }
    this.enqueue({
      agentId: agent, projectId: task.projectId, goalId: task.goalId, taskId, kind: "followup", mode: "work",
      prompt: `Message from the player: ${text}\n\nAnswer it. If it changes the work, update the files, then call update_task with task_id ${taskId} and status review and a summary.`,
    });
    this.changed(task.projectId);
    this.pump();
  }

  /** The player's verdict on the plan the boss proposed. */
  answerPlan(goalId: string, option: "approve" | "changes" | "reject", text?: string): { ok: true } | { ok: false; error: string } {
    const board = this.d.board;
    const goal = board.goal(goalId);
    if (!goal || goal.status !== "planning" || goal.planState !== "proposed") return { ok: false, error: "plan is not waiting" };
    if (option === "changes") {
      const note = text?.trim();
      if (!note) return { ok: false, error: "say what to change" };
      board.addGoalNote(goalId, note);
      board.setPlanState(goalId, "none");
    } else if (option === "approve") {
      board.setPlanState(goalId, "approved");
    } else {
      board.setGoalStatus(goalId, "cancelled");
    }
    this.changed(goal.projectId);
    void this.tick();
    return { ok: true };
  }

  /** The player's answer to an `ask_player` question: unblock the task and give the agent a followup. */
  answer(taskId: string, text: string): void {
    const board = this.d.board;
    const task = board.task(taskId);
    if (!task || task.status !== "blocked") return;
    board.addNote(taskId, "answer", `${task.blockedReason ?? "question"} Answer: ${text}`);
    board.update(taskId, { blockedReason: null });
    board.setStatus(taskId, "todo");
    if (task.parentId !== null && task.assignee) {
      try {
        board.setStatus(taskId, "doing");
        this.holdSlot(task.projectId, taskId);
        this.enqueue({
          agentId: task.assignee, projectId: task.projectId, goalId: task.goalId, taskId, kind: "followup", mode: "work",
          prompt: `The player answered your question on ${taskId}: ${text}\n\nContinue the task. When finished, call update_task with task_id ${taskId} and status review and a summary.`,
        });
      } catch (e) {
        if (!(e instanceof BoardError)) throw e;
        // deps are not done: the task stays todo and starts with the answer in its work prompt
      }
    } else {
      this.hold(taskId, `The player answered: ${text}`);
    }
    board.rollup(task.goalId);
    this.changed(task.projectId);
    void this.tick();
  }

  /** The player's verdict on a task in approval. */
  review(taskId: string, option: "merge" | "changes" | "reject", text?: string): { ok: true } | { ok: false; error: string } {
    const board = this.d.board;
    const task = board.task(taskId);
    if (!task) return { ok: false, error: `unknown task ${taskId}` };
    if (task.status !== "approval") return { ok: false, error: `${taskId} is ${task.status}, not approval` };
    const root = this.rootOf(task.projectId);
    if (option === "reject") {
      board.setStatus(taskId, "cancelled");
      this.dropWorktree(board.task(taskId)!);
      return this.settled(task);
    }
    if (option === "changes") {
      if (!task.assignee) return { ok: false, error: `${taskId} has no assignee` };
      board.setStatus(taskId, "doing");
      this.enqueue({
        agentId: task.assignee, projectId: task.projectId, goalId: task.goalId, taskId, kind: "followup", mode: "work",
        prompt: `The player reviewed ${taskId} and requested changes:\n${text?.trim() || "(no details given)"}\n\nMake the changes, re-run the tests, then call update_task with task_id ${taskId} and status review and a summary.`,
      });
      return this.settled(task);
    }
    if (!task.branch) return { ok: false, error: `${taskId} has no branch` };
    try {
      const dirty = gitChanges(root);
      if (dirty.length > 0) return { ok: false, error: `the project folder has ${dirty.length} uncommitted change(s). Commit or stash them, then merge again.` };
      const merged = mergeTask(root, task.branch);
      if (merged.ok) {
        board.setStatus(taskId, "done");
        this.dropWorktree(board.task(taskId)!);
        return this.settled(task);
      }
      if (!merged.detail.startsWith("Merging ")) return { ok: false, error: merged.detail };
      return this.conflict(task, root);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }

  action(taskId: string, action: "retry" | "cancel" | "rollback" | "pause" | "resume"): { ok: true } | { ok: false; error: string } {
    const board = this.d.board;
    const task = board.task(taskId);
    if (!task) return { ok: false, error: `unknown task ${taskId}` };
    if (action === "rollback") return this.rollback(task);
    if (action === "pause") return this.holdTask(task);
    if (action === "resume") return this.releaseTask(task);
    if (action === "cancel") {
      this.cancelTask(task);
    } else if (task.status === "blocked" || task.status === "done" || task.status === "cancelled") {
      this.forgetCancelledDeps(task);
      board.setStatus(taskId, "todo");
      board.update(taskId, { blockedReason: null, nudges: 0, testFixes: 0, sendBacks: 0, conflicts: 0, ci: "none" });
      const goal = board.goal(task.goalId);
      if (goal && (goal.status === "cancelled" || goal.status === "failed" || goal.status === "done")) board.setGoalStatus(goal.id, "active");
    } else {
      return { ok: true };
    }
    board.rollup(task.goalId);
    this.changed(task.projectId);
    void this.tick();
    return { ok: true };
  }

  /** A todo task that waits on a cancelled task is blocked with the reason, so the Inbox shows a card for it. A held task waits for its resume. */
  private blockCancelled(goalId: string): void {
    const all = this.d.board.tasks(goalId);
    const byId = new Map(all.map((t) => [t.id, t]));
    for (const task of all) {
      if (task.status !== "todo" || task.held) continue;
      const team = task.parentId === null ? undefined : byId.get(task.parentId);
      const dep = [...task.deps, ...(team?.deps ?? [])].map((id) => byId.get(id)).find((d) => d?.status === "cancelled");
      if (dep) this.block(task, `dependency "${dep.title}" was cancelled`);
    }
  }

  /** Retry drops the cancelled deps of the task and of its team, so the task can run. Every task blocked for a dep it no longer has goes back to todo. */
  private forgetCancelledDeps(task: Task): void {
    const board = this.d.board;
    const gone = (id: string) => board.task(id)?.status === "cancelled";
    const own = task.deps.filter((id) => !gone(id));
    if (own.length !== task.deps.length) board.update(task.id, { deps: own });
    if (task.parentId === null) return;
    const team = board.task(task.parentId);
    if (!team) return;
    const cleared = team.deps.filter((id) => gone(id));
    if (cleared.length === 0) return;
    board.update(team.id, { deps: team.deps.filter((id) => !gone(id)) });
    const reasons = new Set(cleared.map((id) => `dependency "${board.task(id)!.title}" was cancelled`));
    // The retried task is left to action, which moves it to todo itself.
    const freed = [team, ...board.children(team.id)].filter((t) => t.id !== task.id && t.status === "blocked" && t.blockedReason !== null && reasons.has(t.blockedReason));
    for (const t of freed) {
      board.setStatus(t.id, "todo");
      board.update(t.id, { blockedReason: null });
    }
  }

  /** Holds one task: aborts its work or review job with stop "pause" and starts none for it until resume. A team task also holds its children that are not done. */
  private holdTask(task: Task): { ok: true } {
    this.holdOne(task);
    if (task.parentId === null) for (const child of this.d.board.children(task.id)) if (child.status !== "done" && child.status !== "cancelled") this.holdOne(child, true);
    this.changed(task.projectId);
    void this.tick();
    return { ok: true };
  }

  private holdOne(task: Task, byParent = false): void {
    if (!task.held) this.d.board.setHeld(task.id, true, byParent);
    for (const r of this.running.values()) {
      if (r.taskId !== task.id || (r.item.mode !== "work" && r.item.mode !== "review" && r.item.mode !== "split")) continue;
      r.stop ??= "pause";
      r.controller.abort();
    }
    // Queued items of the task never start. A task with no running job gives up its slot and goes back to todo.
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.taskId === task.id) this.queue.splice(i, 1);
    if (![...this.running.values()].some((r) => r.taskId === task.id)) {
      this.release(task);
      this.recoverProject(task.projectId, true, task.id);
    }
  }

  private releaseTask(task: Task): { ok: true } {
    if (task.held) this.d.board.setHeld(task.id, false);
    if (task.parentId === null) for (const child of this.d.board.children(task.id)) if (child.heldByParent) this.d.board.setHeld(child.id, false);
    this.known.add(task.projectId);
    this.changed(task.projectId);
    void this.tick();
    return { ok: true };
  }

  /** Puts the worktree back to the task's checkpoint and the task back to todo. */
  private rollback(task: Task): { ok: true } | { ok: false; error: string } {
    const board = this.d.board;
    const busy = [...this.running.values()].some((r) => r.taskId === task.id) || this.queue.some((q) => q.taskId === task.id);
    if (busy || task.status === "doing" || task.status === "review") return { ok: false, error: "stop the task first" };
    if (task.checkpoint === null || task.worktree === null) return { ok: false, error: "no checkpoint yet" };
    if (!commitExists(task.worktree, task.checkpoint)) return { ok: false, error: "checkpoint is gone" };
    // Without the config the protected paths are unknown, and the reset would delete an untracked .env.
    const loaded = loadProjectConfig(this.d.home, task.projectId);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    try {
      resetTo(task.worktree, task.checkpoint, loaded.config.protectedPaths);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
    // The checks above allow the rollback, so the move to todo must not throw after the reset.
    board.setStatus(task.id, "todo", { force: true });
    board.update(task.id, { blockedReason: null, nudges: 0, testFixes: 0, sendBacks: 0, conflicts: 0 });
    const goal = board.goal(task.goalId);
    if (goal && (goal.status === "cancelled" || goal.status === "failed" || goal.status === "done")) board.setGoalStatus(goal.id, "active");
    board.addNote(task.id, "rollback", `rolled back to ${task.checkpoint.slice(0, 7)}`);
    board.rollup(task.goalId);
    this.changed(task.projectId);
    void this.tick();
    return { ok: true };
  }

  /** Restart: a task left in doing goes back to todo with its worktree kept. A task left in review moves to approval. */
  recover(): void {
    for (const project of this.projectIds()) this.recoverProject(project);
  }

  /** Aborts the project's work, followup and review jobs and starts none until `resume`. Plan, tasks and split jobs run to their end, so a task list is never left half made. Queued jobs stay queued. */
  pause(projectId: string): { ok: true } | { ok: false; error: string } {
    if (!this.projectIds().includes(projectId)) return { ok: false, error: `No project ${projectId}` };
    this.d.board.setPaused(projectId, true);
    for (const r of this.running.values()) {
      if (r.item.projectId !== projectId || (r.item.mode !== "work" && r.item.mode !== "review")) continue;
      r.stop ??= "pause";
      r.controller.abort();
    }
    this.changed(projectId);
    return { ok: true };
  }

  resume(projectId: string): { ok: true } | { ok: false; error: string } {
    if (!this.projectIds().includes(projectId)) return { ok: false, error: `No project ${projectId}` };
    if (this.removing.has(projectId)) return { ok: false, error: "removing" };
    this.unpause(projectId);
    return { ok: true };
  }

  private unpause(projectId: string): void {
    this.d.board.setPaused(projectId, false);
    this.known.add(projectId);
    this.changed(projectId);
    void this.tick();
  }

  /**
   * Deletes the project: board rows, config, sandbox, task worktrees and the agent branches of a linked git folder.
   * Pauses it first and waits up to 10 s for its jobs, test runs and chat turns to end, else answers "stop the runs first" and leaves the project as it was.
   * Chats stay as history. A linked folder and its files stay.
   */
  async forget(projectId: string): Promise<({ ok: true } & RemovedFiles) | { ok: false; error: string }> {
    if (this.removing.has(projectId)) return { ok: false, error: `already removing ${projectId}` };
    this.removing.add(projectId);
    try {
      return await this.forgetNow(projectId);
    } finally {
      this.removing.delete(projectId);
    }
  }

  private async forgetNow(projectId: string): Promise<({ ok: true } & RemovedFiles) | { ok: false; error: string }> {
    const wasPaused = this.d.board.paused().includes(projectId);
    const paused = this.pause(projectId);
    if (!paused.ok) return paused;
    const testing = () => this.d.board.goals(projectId).some((g) => this.d.board.tasks(g.id).some((t) => t.ci === "running"));
    const active = () =>
      [...this.running.values()].some((r) => r.item.projectId === projectId) || (this.d.projectBusy?.(projectId) ?? false) || testing() || (this.d.chatBusy?.(projectId) ?? false);
    // A chat turn may start between two polls, so each poll aborts again.
    this.d.abortChats?.(projectId);
    for (let waited = 0; active(); waited += FORGET_STEP_MS) {
      if (waited >= FORGET_WAIT_MS) {
        if (!wasPaused) this.unpause(projectId);
        return { ok: false, error: "stop the runs first" };
      }
      await new Promise((r) => setTimeout(r, FORGET_STEP_MS));
      this.d.abortChats?.(projectId);
    }
    // Branches and folders go first, so a file error leaves the project listed and retryable.
    let removed: RemovedFiles;
    try {
      removed = removeProjectFiles(this.d.home, projectId, this.d.board.branches(projectId));
      this.d.board.deleteProject(projectId);
    } catch (e) {
      if (!wasPaused) this.unpause(projectId);
      return { ok: false, error: errorText(e) };
    }
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.projectId === projectId) this.queue.splice(i, 1);
    this.known.delete(projectId);
    this.holds.delete(projectId);
    this.changed(projectId);
    return { ok: true, ...removed };
  }

  pauseAll(): void {
    for (const id of this.projectIds()) this.pause(id);
  }

  resumeAll(): void {
    for (const id of this.d.board.paused()) this.resume(id);
  }

  /** A task left in doing goes back to todo with its worktree kept. A task left in review moves to approval. */
  private recoverProject(project: string, paused = false, only?: string): void {
    const board = this.d.board;
    this.known.add(project);
    for (const goal of board.goals(project)) {
      for (const task of board.tasks(goal.id)) {
        if (only !== undefined && task.id !== only) continue;
        if (this.running.has(task.assignee ?? "") && this.runningTask(task.assignee!) === task.id) continue;
        if (this.queue.some((q) => q.taskId === task.id)) continue;
        // A pause leaves a task in its test run alone: toReview goes on when the tests end.
        if (paused && task.ci === "running") continue;
        if (task.ci === "running") board.update(task.id, { ci: "none" });
        if (task.status === "doing" && task.parentId !== null) board.setStatus(task.id, "todo");
        else if (task.status === "review") board.setStatus(task.id, "approval");
      }
      board.rollup(goal.id);
    }
    this.changed(project);
  }

  // ---------------------------------------------------------------- tick

  private tickProject(project: string): void {
    const board = this.d.board;
    if (board.paused().includes(project)) return;
    const loaded = loadProjectConfig(this.d.home, project);
    if (!loaded.ok) return;
    const config = loaded.config;
    const goals = board.goals(project).filter((g) => g.status === "planning" || g.status === "active");
    if (goals.length === 0) return;
    if (!this.prepareRoot(project, config)) {
      for (const g of goals.filter((x) => x.status === "planning")) board.setGoalStatus(g.id, "failed");
      this.changed(project);
      return;
    }
    const profiles = this.profiles(config);
    const boss = profiles.find((p) => p.role === "boss");
    const managers = profiles.filter((p) => p.role === "manager");
    const max = this.maxConcurrent(project);

    for (const goal of goals) {
      if (board.tasks(goal.id).length === 0 && goal.status === "planning") {
        if (!boss) {
          board.setGoalStatus(goal.id, "failed");
          this.changed(project);
          continue;
        }
        if (goal.planState === "approved" && managers.length === 0) {
          // No manager: the boss owns one team task and splits it into worker tasks itself.
          board.createTask({ goalId: goal.id, title: goal.text, description: goal.text, assignee: boss.id, createdBy: boss.id });
          board.setGoalStatus(goal.id, "active");
          this.changed(project);
        } else {
          // A plan waits for the player (proposed); an approved plan goes to the managers as tasks.
          const kind = goal.planState === "none" ? "plan" : goal.planState === "approved" ? "tasks" : undefined;
          if (kind && !this.planning.has(goal.id) && this.dayStopped.get(goal.id) !== dayKey(new Date())) {
            this.planning.add(goal.id);
            this.enqueue({ agentId: boss.id, projectId: project, goalId: goal.id, kind, mode: "plan" });
          }
          continue;
        }
      }
      // A team task blocked for no team restarts once its manager has a worker.
      for (const blocked of board.tasks(goal.id).filter((t) => t.parentId === null && t.status === "blocked" && !t.held && t.blockedReason?.startsWith(NO_TEAM))) {
        const lead = blocked.assignee ?? managers[0]?.id ?? boss?.id;
        if (!lead || this.teamOf(config, lead).length === 0) continue;
        board.setStatus(blocked.id, "todo", { force: true });
        board.update(blocked.id, { blockedReason: null });
      }
      this.blockCancelled(goal.id);
      const tasks = board.tasks(goal.id);
      const blockedIds = new Set(tasks.filter((t) => t.status === "blocked").map((t) => t.id));
      for (const team of tasks.filter((t) => t.parentId === null && t.status === "todo" && !t.held)) {
        if (this.splitting.has(team.id) || tasks.some((t) => t.parentId === team.id)) continue;
        // A dependency that is blocked holds the team back. It splits once the dependency is retried.
        if (team.deps.some((d) => blockedIds.has(d))) continue;
        const lead = team.assignee ?? managers[0]?.id ?? boss?.id;
        if (!lead) continue;
        if (this.teamOf(config, lead).length === 0) {
          this.block(team, `${NO_TEAM} grant a worker to ${project} in Configure`);
          continue;
        }
        if (team.assignee === null) board.update(team.id, { assignee: lead });
        this.splitting.add(team.id);
        // A rejection of an earlier split that never reached afterSplit (paused, cancelled or stopped) is stale.
        this.rejected.delete(team.id);
        this.enqueue({ agentId: lead, projectId: project, goalId: goal.id, taskId: team.id, kind: "split", mode: "split" });
      }
      for (const task of board.ready(goal.id)) {
        if ((this.holds.get(project)?.size ?? 0) >= max) break;
        const parent = task.parentId === null ? undefined : board.task(task.parentId);
        if (!parent || parent.status === "cancelled" || parent.status === "blocked") continue;
        const agent = task.assignee ?? this.pickFree(this.teamOf(config, parent.assignee));
        if (!agent || !this.agentFree(agent)) continue;
        try {
          if (task.assignee !== agent) board.update(task.id, { assignee: agent });
          board.setStatus(task.id, "doing");
        } catch (e) {
          if (e instanceof BoardError) continue;
          throw e;
        }
        this.holdSlot(project, task.id);
        board.rollup(goal.id);
        this.enqueue({ agentId: agent, projectId: project, goalId: goal.id, taskId: task.id, kind: "work", mode: "work" });
        this.changed(project);
      }
    }
  }

  // ---------------------------------------------------------------- queue

  private enqueue(item: Item): void {
    this.queue.push(item);
  }

  /** Starts queued jobs whose agent is idle and whose project slot is free. */
  private pump(): void {
    if (this.stopped) return;
    const paused = new Set(this.d.board.paused());
    for (let i = 0; i < this.queue.length; ) {
      const item = this.queue[i]!;
      if (paused.has(item.projectId) || (item.taskId && this.d.board.task(item.taskId)?.held) || this.running.has(item.agentId) || this.d.chatting?.(item.agentId) || !this.admit(item)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.launch(item);
    }
  }

  private admit(item: Item): boolean {
    if (item.mode !== "work") {
      for (const r of this.running.values()) if (r.item.projectId === item.projectId && r.item.mode !== "work") return false;
      return true;
    }
    if (!item.taskId || this.holds.get(item.projectId)?.has(item.taskId)) return true;
    if ((this.holds.get(item.projectId)?.size ?? 0) >= this.maxConcurrent(item.projectId)) return false;
    this.holdSlot(item.projectId, item.taskId);
    return true;
  }

  private launch(item: Item): void {
    const run: Running = { item, taskId: item.taskId, controller: new AbortController(), inbox: [], startedAt: (this.d.now ?? (() => new Date()))() };
    this.running.set(item.agentId, run);
    const chain: Promise<void> = this.execute(item, run)
      .catch((e: unknown) => this.log(`scheduler: ${item.kind} ${item.taskId ?? item.goalId}: ${errorText(e)}`))
      .finally(() => this.chains.delete(chain));
    this.chains.add(chain);
  }

  private async execute(item: Item, run: Running): Promise<void> {
    let result: RunResult | undefined;
    let error: unknown;
    try {
      const { job, tools } = this.build(item);
      const runId = randomBytes(6).toString("hex");
      job.runId = runId;
      if (item.taskId) this.d.board.addRun(item.taskId, runId, item.kind as RunKind);
      this.changed(item.projectId);
      result = await this.d.jobs.run(job, tools, run.controller.signal, () => run.inbox.splice(0));
    } catch (e) {
      error = e;
    } finally {
      this.running.delete(item.agentId);
    }
    this.d.onAgentFree?.(item.agentId);
    try {
      await this.after(item, run, result, error);
    } catch (e) {
      this.log(`scheduler: after ${item.kind} ${item.taskId ?? item.goalId}: ${errorText(e)}`);
      this.failSafe(item, errorText(e));
    }
    if (!run.retried) {
      if (item.mode === "plan") this.planning.delete(item.goalId);
      if (item.mode === "split" && item.taskId) this.splitting.delete(item.taskId);
    }
    this.changed(item.projectId);
    this.pump();
    void this.tick();
  }

  // ---------------------------------------------------------------- job setup

  /** The job and its board tools. Leads work in the project root, workers in the task worktree. */
  private build(item: Item): { job: Job; tools: AnyTool[] } {
    const board = this.d.board;
    const goal = board.goal(item.goalId);
    if (!goal) throw new Error(`unknown goal ${item.goalId}`);
    const loaded = loadProjectConfig(this.d.home, item.projectId);
    if (!loaded.ok) throw new Error(loaded.error);
    const config = loaded.config;
    const root = this.rootOf(item.projectId);
    const me = this.d.agents.get(item.agentId);
    if (!me) throw new Error(`no agent ${item.agentId}`);
    const onChange = () => this.changed(item.projectId);
    const ctx = (over: Partial<BoardToolCtx>): BoardToolCtx => ({
      board, goalId: goal.id, agentId: me.id, role: me.role, allowedAssignees: [], onChange, onQuestion: onChange, ...over,
    });
    const base = {
      kind: item.kind, projectId: item.projectId, goalId: goal.id, agentId: me.id, cwd: root,
      ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
    };

    if (item.mode === "plan") {
      const managers = this.profiles(config).filter((p) => p.role === "manager");
      if (item.kind === "tasks") {
        const tools = [makeCreateTaskTool(ctx({ role: "boss", allowedAssignees: managers.map((m) => m.id) }))];
        return { job: { ...base, prompt: this.retried(item, tasksPrompt(goal, goal.plan ?? "", board.tasks(goal.id), managers.map(member))) }, tools };
      }
      // Notes stay in the store until a plan answers them, so a job that dies does not lose them.
      const notes = board.goalNotes(goal.id);
      item.notesUpTo = notes.at(-1)?.id ?? 0;
      const tools = [makeProposePlanTool(ctx({ role: "boss" }))];
      return { job: { ...base, prompt: this.retried(item, planPrompt(goal, managers.map(member), goal.plan, notes.map((n) => n.text))) }, tools };
    }

    const task = item.taskId ? board.task(item.taskId) : undefined;
    if (!task) throw new Error(`unknown task ${item.taskId}`);

    if (item.mode === "split") {
      const team = this.teamOf(config, me.id);
      const tools = [
        makeCreateTaskTool(ctx({
          role: "manager", taskId: task.id, allowedAssignees: team.map((m) => m.id),
          onRejected: (text) => this.rejected.set(task.id, text),
        })),
        makeAskPlayerTool(ctx({ taskId: task.id })),
      ];
      const prompt = this.retried(item, this.withHeld(task.id, item.prompt ?? splitPrompt(goal, task, board.tasks(goal.id), team.map(member))));
      return { job: { ...base, prompt }, tools };
    }

    if (item.mode === "review") {
      const tools = [
        makeRequestMergeTool(ctx({ taskId: task.id, reviewer: me.id })),
        makeUpdateTaskTool(ctx({ taskId: task.id, reviewer: me.id })),
        makeAskPlayerTool(ctx({ taskId: task.id, reviewer: me.id })),
      ];
      // The reviewer reads the worker's folder, where the change is. Without a worktree on disk it reads the root.
      const reviewCwd = task.worktree && fs.existsSync(task.worktree) ? task.worktree : root;
      return { job: { ...base, cwd: reviewCwd, prompt: this.withHeld(task.id, item.prompt ?? "") }, tools };
    }

    // work and the followups of a worker: the task worktree
    this.prepareRoot(item.projectId, config);
    const branchName = task.branch ?? `agent/${me.id}/${task.id}`;
    const continues = task.branch !== null && branchExists(root, branchName);
    const wt = openWorktree(root, worktreePath(this.d.home, item.projectId, task.id), branchName);
    board.update(task.id, { branch: wt.branch, worktree: wt.path });
    const tools = [makeUpdateTaskTool(ctx({ taskId: task.id })), makeAskPlayerTool(ctx({ taskId: task.id }))];
    // The checkpoint is what a rollback returns to: whatever the worktree holds as this job starts.
    commitAll(wt.path, "AgentCity checkpoint", `${task.id}: checkpoint`, config.protectedPaths);
    board.update(task.id, { checkpoint: headSha(wt.path) });
    const held = board.takeNotes(task.id, "held");
    // A rollback wipes what the last run did, so its note would mislead.
    const rolled = board.takeNotes(task.id, "rollback").length > 0;
    let note: string | undefined;
    try {
      const lastRun = board.runs(task.id).at(-1)?.runId;
      note = rolled || lastRun === undefined ? undefined : resumeNote(this.d.runRows?.(lastRun) ?? [], (s) => s);
    } catch (e) {
      this.log(`scheduler: resume note for ${task.id}: ${errorText(e)}`);
    }
    const prompt = item.prompt !== undefined
      ? this.appendHeld(item.prompt, held) + (note ? `\n\n${note}` : "")
      : workPrompt(goal, task, board.tasks(goal.id), {
        worktree: wt.path, branch: wt.branch, base: wt.base, answers: board.notes(task.id, "answer"), inbox: held, continues,
        ...(note ? { resume: note } : {}),
      });
    return { job: { ...base, cwd: wt.path, prompt }, tools };
  }

  // ---------------------------------------------------------------- after a job

  private async after(item: Item, run: Running, result: RunResult | undefined, error: unknown): Promise<void> {
    if (run.stop === "stop") return;
    if (run.stop === "pause") {
      const paused = item.taskId ? this.d.board.task(item.taskId) : undefined;
      if (paused) this.release(paused);
      // A held task alone is recovered alone, so a pause of one task leaves the others as they are.
      this.recoverProject(item.projectId, true, this.d.board.paused().includes(item.projectId) ? undefined : item.taskId);
      return;
    }
    const board = this.d.board;
    const task = item.taskId ? board.task(item.taskId) : undefined;
    if (run.stop === "cancel") {
      if (task) {
        if (task.parentId !== null) this.dropWorktree(task);
        this.release(task);
      }
      return;
    }
    const hard = error !== undefined || (result !== undefined && !SOFT_REASONS.has(result.reason));
    const why = error !== undefined
      ? `job failed: ${errorText(error)}`
      : this.budgetWhy(item.projectId, result?.reason)
        ?? `run stopped: ${result?.reason ?? "unknown"}${result?.detail ? `: ${result.detail}` : ""}`;

    if (this.retryable(item, result)) {
      run.retried = true;
      this.enqueue({ ...item, tries: 1 });
      return;
    }
    if (item.mode === "plan") return this.afterPlan(item, error === undefined ? result?.reason : undefined);
    if (item.mode === "split") return this.afterSplit(item, hard, why);
    if (!task || task.status === "cancelled") {
      if (task) this.release(task);
      return;
    }
    if (item.mode === "review") return this.afterReview(task, hard);
    return this.afterWork(task, hard, why);
  }

  /** The blocked reason for a budget stop, with the project's caps. undefined for any other reason. */
  private budgetWhy(project: string, reason: string | undefined): string | undefined {
    if (reason !== "budget_job" && reason !== "budget_day") return undefined;
    const loaded = loadProjectConfig(this.d.home, project);
    const budget = loaded.ok ? loaded.config.budget : defaultProjectConfig(project).budget;
    return reason === "budget_job"
      ? `stopped: this job used its ${budget.jobTokens.toLocaleString("en-US")} tokens. Answer to continue with a new job.`
      : `stopped: the project spent its $${budget.dayUsd} for today.`;
  }

  /** A plan, tasks or split job that ends without its result gets one more turn. A budget stop and a second miss do not. */
  private retryable(item: Item, result: RunResult | undefined): boolean {
    if (item.tries || (item.mode !== "plan" && item.mode !== "split")) return false;
    if (this.budgetWhy(item.projectId, result?.reason) !== undefined) return false;
    return this.resultMissing(item);
  }

  /** Whether the job ended without its result: no propose_plan for a plan, no team task for tasks, no worker task for a split. */
  private resultMissing(item: Item): boolean {
    const board = this.d.board;
    if (item.mode === "split") {
      const team = item.taskId ? board.task(item.taskId) : undefined;
      return team !== undefined && team.status === "todo" && board.children(team.id).length === 0;
    }
    const goal = board.goal(item.goalId);
    if (!goal || (goal.status !== "planning" && goal.status !== "active")) return false;
    if (item.kind === "plan") return goal.planState === "none";
    return !board.tasks(goal.id).some((t) => t.parentId === null);
  }

  /** A job on its second turn keeps its prompt and names the tool it missed. */
  private retried(item: Item, prompt: string): string {
    const tool = RESULT_TOOL[item.kind];
    if (!item.tries || !tool) return prompt;
    return `${prompt}\n\nYour last turn ended without ${tool}. Call it now.`;
  }

  private afterPlan(item: Item, reason: string | undefined): void {
    const board = this.d.board;
    const goal = board.goal(item.goalId);
    if (!goal || (goal.status !== "planning" && goal.status !== "active")) return;
    const teams = board.tasks(goal.id).filter((t) => t.parentId === null);
    if (reason === "budget_day" && (item.kind === "plan" ? goal.planState === "none" : teams.length === 0)) {
      // Out of money for today: the goal keeps planning and runs again tomorrow.
      this.dayStopped.set(goal.id, dayKey(new Date()));
      return;
    }
    if (item.kind === "plan") {
      const upTo = item.notesUpTo ?? 0;
      // A posted plan answered the notes in its prompt. A newer note means the player asked for changes during the job.
      const asked = board.goalNotes(goal.id).some((n) => n.id > upTo);
      if (goal.planState !== "none" || asked) board.clearGoalNotes(goal.id, upTo);
      else board.setGoalStatus(goal.id, "failed");
      return;
    }
    if (teams.length === 0) board.setGoalStatus(goal.id, "failed");
    else if (goal.status === "planning") board.setGoalStatus(goal.id, "active");
  }

  private afterSplit(item: Item, hard: boolean, why: string): void {
    const board = this.d.board;
    const team = item.taskId ? board.task(item.taskId) : undefined;
    const rejected = item.taskId ? this.rejected.get(item.taskId) : undefined;
    if (item.taskId) this.rejected.delete(item.taskId);
    if (!team) return;
    if (board.children(team.id).length === 0) {
      if (team.status === "todo") this.block(team, hard ? why : rejected ? `split created no tasks: ${rejected}` : "split created no tasks");
    } else {
      board.rollup(team.goalId);
    }
  }

  private async afterWork(first: Task, hard: boolean, why: string): Promise<void> {
    const board = this.d.board;
    let task = first;
    if (task.status === "doing") {
      if (hard) {
        this.block(task, why);
        this.release(task);
        return;
      }
      if (task.nudges < this.limitsOf(task.projectId).reminders && task.assignee) {
        board.update(task.id, { nudges: task.nudges + 1 });
        this.enqueue({
          agentId: task.assignee, projectId: task.projectId, goalId: task.goalId, taskId: task.id, kind: "followup", mode: "work",
          prompt: nudgePrompt(task),
        });
        return;
      }
      if (this.changes(task) === 0) {
        this.block(task, "stopped without changes");
        this.release(task);
        return;
      }
      board.setStatus(task.id, "review");
      board.rollup(task.goalId);
      task = board.task(task.id)!;
    }
    if (task.status === "review") return this.toReview(task);
    this.release(task);
  }

  /** Commit, run the tests, then hand the task to its reviewer. One failed test run goes back to the worker first. */
  private async toReview(task: Task): Promise<void> {
    const board = this.d.board;
    const root = this.rootOf(task.projectId);
    const wt = task.worktree;
    if (!wt || this.changes(task) === 0) {
      this.block(task, "no changes");
      this.release(task);
      return;
    }
    const base = baseBranch(root);
    const author = this.d.agents.get(task.assignee ?? "")?.name ?? task.assignee ?? "agent";
    const loaded = loadProjectConfig(this.d.home, task.projectId);
    commitAll(wt, `AgentCity ${author}`, `${task.id}: ${task.title}`, loaded.ok ? loaded.config.protectedPaths : []);

    let test: { command?: string; pass?: boolean; output?: string } = {};
    const command = testCommand(wt, this.boardConfig(task.projectId).testCommand);
    if (command) {
      board.update(task.id, { ci: "running" });
      this.changed(task.projectId);
      const r = await runTests(wt, command);
      const now = board.task(task.id);
      if (!now || now.status !== "review") {
        this.release(task);
        return;
      }
      board.update(task.id, { ci: r.pass ? "pass" : "fail", testOutput: r.output });
      test = { command, pass: r.pass, output: r.output };
      if (!r.pass && now.held) {
        // The player paused the task during the run: no fix job starts, the task waits in todo with its worktree.
        board.update(task.id, { ci: "none" });
        board.setStatus(task.id, "todo", { force: true });
        board.rollup(task.goalId);
        this.release(task);
        void this.tick();
        return;
      }
      if (!r.pass && now.testFixes < this.limitsOf(task.projectId).testFixes && now.assignee) {
        board.update(task.id, { testFixes: now.testFixes + 1 });
        board.setStatus(task.id, "doing");
        board.rollup(task.goalId);
        this.enqueue({
          agentId: now.assignee, projectId: task.projectId, goalId: task.goalId, taskId: task.id, kind: "followup", mode: "work",
          prompt: `Tests failed for ${task.id} (${command}):\n${r.output}\n\nFix the failures, re-run the tests, then call update_task with task_id ${task.id} and status review and a summary.`,
        });
        return;
      }
    }
    this.release(task);
    const fresh = board.task(task.id)!;
    const reviewer = this.reviewerOf(fresh);
    if (!reviewer) {
      board.setStatus(task.id, "approval");
      board.rollup(task.goalId);
      return;
    }
    let diff: string;
    try {
      diff = fresh.branch ? diffText(taskDiff(root, base, fresh.branch)) : "(no branch)";
    } catch (e) {
      diff = `(diff unavailable: ${errorText(e)})`;
    }
    this.enqueue({
      agentId: reviewer, projectId: task.projectId, goalId: task.goalId, taskId: task.id, kind: "review", mode: "review",
      prompt: reviewPrompt(fresh, fresh.summary ?? "(no summary)", test, diff),
    });
  }

  private afterReview(first: Task, hard: boolean): void {
    const board = this.d.board;
    const task = first;
    if (task.status === "review") {
      // no verdict: the player decides
      board.setStatus(task.id, "approval");
    } else if (task.status === "doing" && task.assignee) {
      const notes = task.summary ?? "(no notes)";
      const limit = this.limitsOf(task.projectId).sendBacks;
      if (task.sendBacks < limit && !hard) {
        board.update(task.id, { sendBacks: task.sendBacks + 1 });
        const reviewer = this.d.agents.get(this.reviewerOf(task) ?? "")?.name ?? "The reviewer";
        this.enqueue({
          agentId: task.assignee, projectId: task.projectId, goalId: task.goalId, taskId: task.id, kind: "followup", mode: "work",
          prompt: `${reviewer} reviewed ${task.id} and asks for changes:\n${notes}\n\nMake the changes, re-run the tests, then call update_task with task_id ${task.id} and status review and a summary.`,
        });
      } else {
        board.update(task.id, { summary: `Review notes after ${limit} send-backs: ${notes}` });
        board.setStatus(task.id, "review");
        board.setStatus(task.id, "approval");
      }
    }
    board.rollup(task.goalId);
  }

  /** A merge conflict: the first one goes back to the worker, the next one blocks the task. */
  private conflict(task: Task, root: string): { ok: false; error: string } {
    const board = this.d.board;
    const base = baseBranch(root);
    board.setStatus(task.id, "doing");
    if (task.conflicts < this.limitsOf(task.projectId).conflicts && task.assignee) {
      board.update(task.id, { conflicts: task.conflicts + 1 });
      this.enqueue({
        agentId: task.assignee, projectId: task.projectId, goalId: task.goalId, taskId: task.id, kind: "followup", mode: "work",
        prompt: `Merging ${task.branch} into ${base} hit a conflict. In your worktree, run git merge ${base} and resolve the conflicts, run the tests, then call update_task with task_id ${task.id} and status review and a summary.`,
      });
      this.settled(task);
      return { ok: false, error: `merge conflict: ${task.id} went back to ${task.assignee} to resolve it` };
    }
    board.update(task.id, { conflicts: task.conflicts + 1 });
    const retries = this.limitsOf(task.projectId).conflicts;
    const reason = retries === 0 ? `merge conflict with ${base}, no retries set` : `merge conflict with ${base} again after ${retries} ${retries === 1 ? "retry" : "retries"}`;
    this.block(board.task(task.id)!, reason);
    this.settled(task);
    return { ok: false, error: `merge conflict again: ${task.id} is blocked` };
  }

  // ---------------------------------------------------------------- helpers

  private block(task: Task, reason: string): void {
    const board = this.d.board;
    try {
      board.setStatus(task.id, "blocked");
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      board.setStatus(task.id, "blocked", { force: true });
    }
    board.update(task.id, { blockedReason: reason });
    board.rollup(task.goalId);
  }

  /** A job ended in an error we did not plan for. Block its task so the board does not wait forever. */
  private failSafe(item: Item, reason: string): void {
    try {
      const task = item.taskId ? this.d.board.task(item.taskId) : undefined;
      if (!task) return;
      if (item.mode === "split" && this.d.board.children(task.id).length > 0) return;
      if (task.status === "todo" || task.status === "doing" || task.status === "review") this.block(task, `scheduler error: ${reason}`);
      this.release(task);
    } catch (e) {
      this.log(`scheduler: failSafe: ${errorText(e)}`);
    }
  }

  private settled(task: Task): { ok: true } {
    this.d.board.rollup(task.goalId);
    this.changed(task.projectId);
    this.pump();
    void this.tick();
    return { ok: true };
  }

  private cancelTask(task: Task): void {
    const board = this.d.board;
    if (task.parentId === null) for (const kid of board.children(task.id)) this.cancelTask(board.task(kid.id)!);
    if (task.status === "done" || task.status === "cancelled") return;
    const run = [...this.running.values()].find((r) => r.taskId === task.id);
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.taskId === task.id) this.queue.splice(i, 1);
    this.splitting.delete(task.id);
    this.release(task);
    try {
      board.setStatus(task.id, "cancelled");
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      return;
    }
    if (run) {
      run.stop = "cancel";
      run.controller.abort();
    } else if (task.parentId !== null) {
      this.dropWorktree(board.task(task.id)!);
    }
  }

  /** Removes the task worktree. The branch stays. */
  private dropWorktree(task: Task): void {
    if (!task.worktree) return;
    try {
      removeWorktree(this.rootOf(task.projectId), task.worktree);
      this.d.board.update(task.id, { worktree: null });
    } catch (e) {
      this.log(`scheduler: remove worktree ${task.worktree}: ${errorText(e)}`);
    }
  }

  private changes(task: Task): number {
    if (!task.worktree) return 0;
    try {
      return changedFiles(task.worktree, baseBranch(this.rootOf(task.projectId)));
    } catch {
      return 0;
    }
  }

  private holdSlot(project: string, taskId: string): void {
    const set = this.holds.get(project) ?? new Set<string>();
    set.add(taskId);
    this.holds.set(project, set);
  }

  private release(task: Task): void {
    this.holds.get(task.projectId)?.delete(task.id);
  }

  private hold(taskId: string, text: string): void {
    this.d.board.addNote(taskId, "held", text);
  }

  private withHeld(taskId: string, prompt: string): string {
    return this.appendHeld(prompt, this.d.board.takeNotes(taskId, "held"));
  }

  private appendHeld(prompt: string, held: string[]): string {
    return held.length === 0 ? prompt : `${prompt}\n\nMessages from the player:\n${held.map((m) => `- ${m}`).join("\n")}`;
  }

  private changed(project: string): void {
    this.d.onChange(project);
  }

  private log(line: string): void {
    this.d.log?.(line);
  }

  /** Whether a board job of the agent runs now. */
  agentRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  private agentFree(agentId: string): boolean {
    return !this.running.has(agentId) && !this.queue.some((q) => q.agentId === agentId) && !this.d.chatting?.(agentId);
  }

  private pickFree(team: AgentProfile[]): string | undefined {
    return team.find((m) => this.agentFree(m.id))?.id;
  }

  /** The agent that reviews a worker task: the assignee of its team task, else the boss. */
  private reviewerOf(task: Task): string | undefined {
    const parent = task.parentId === null ? undefined : this.d.board.task(task.parentId);
    if (parent?.assignee) return parent.assignee;
    const loaded = loadProjectConfig(this.d.home, task.projectId);
    return loaded.ok ? this.profiles(loaded.config).find((p) => p.role === "boss")?.id : undefined;
  }

  private profiles(config: ProjectConfig): AgentProfile[] {
    return config.agents.map((id) => this.d.agents.get(id)).filter((p): p is AgentProfile => p !== undefined);
  }

  /** Workers a lead may assign: the workers of its building when it is a manager, every worker of the project for the boss. A manager whose building has none gets every worker. */
  private teamOf(config: ProjectConfig, leadId: string | null): AgentProfile[] {
    const workers = this.profiles(config).filter((p) => p.role === "worker");
    const lead = leadId ? this.d.agents.get(leadId) : undefined;
    if (lead?.role !== "manager") return workers;
    const mine = workers.filter((w) => w.building === lead.building);
    return mine.length > 0 ? mine : workers;
  }

  private rootOf(project: string): string {
    const loaded = loadProjectConfig(this.d.home, project);
    return workDir(this.d.home, loaded.ok ? loaded.config : undefined, project);
  }

  /** A sandbox project becomes a git repo. A linked folder must already be one. */
  private prepareRoot(project: string, config: ProjectConfig): boolean {
    const root = workDir(this.d.home, config, project);
    try {
      if (config.workspace) return isGitRepo(root);
      ensureRepo(root);
      return true;
    } catch (e) {
      this.log(`scheduler: ${project}: ${errorText(e)}`);
      return false;
    }
  }

  /** The limits the project config has now. A config that does not load reads the defaults. */
  private limitsOf(project: string): Limits {
    const loaded = loadProjectConfig(this.d.home, project);
    return loaded.ok ? loaded.config.limits : defaultProjectConfig(project).limits;
  }

  /** `board` in project.json: `testCommand`. */
  private boardConfig(project: string): { testCommand?: string } {
    const loaded = loadProjectConfig(this.d.home, project);
    const cmd = loaded.ok ? loaded.config.board?.testCommand : undefined;
    return typeof cmd === "string" && cmd.trim() !== "" ? { testCommand: cmd } : {};
  }

  /** limits.parallelJobs of the project. 0 means no limit. */
  private maxConcurrent(project: string): number {
    const n = this.limitsOf(project).parallelJobs;
    return n === 0 ? Infinity : n;
  }

  private projectIds(): string[] {
    try {
      return fs.readdirSync(path.join(this.d.home, "projects"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}

const member = (p: AgentProfile): Member => ({ id: p.id, name: p.name });
