import type Database from "better-sqlite3";
import { redact } from "./redact.js";

export type TaskStatus = "todo" | "doing" | "review" | "approval" | "done" | "blocked" | "cancelled";
export type GoalStatus = "planning" | "active" | "done" | "cancelled" | "failed";
export type PlanState = "none" | "proposed" | "approved";
export type CiState = "none" | "running" | "pass" | "fail";
export type RunKind = "plan" | "tasks" | "split" | "work" | "review" | "followup";

export interface Goal {
  id: string;
  projectId: string;
  text: string;
  status: GoalStatus;
  plan: string | null;
  planState: PlanState;
  planBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A team task has parentId null. A worker task has the team task as parent. */
export interface Task {
  id: string;
  goalId: string;
  parentId: string | null;
  projectId: string;
  title: string;
  description: string;
  assignee: string | null;
  deps: string[];
  status: TaskStatus;
  branch: string | null;
  worktree: string | null;
  summary: string | null;
  blockedReason: string | null;
  checkpoint: string | null;
  ci: CiState;
  testOutput: string | null;
  sendBacks: number;
  nudges: number;
  testFixes: number;
  conflicts: number;
  /** The player paused this task: no job starts for it until resume. */
  held: boolean;
  /** The pause of the team task held this task, not the player's own pause. Resuming the team task releases it. */
  heldByParent: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskPatch = Partial<
  Pick<Task, "title" | "description" | "assignee" | "deps" | "branch" | "worktree" | "summary" | "blockedReason" | "checkpoint" | "ci" | "testOutput" | "sendBacks" | "nudges" | "testFixes" | "conflicts">
>;

/** A refused write. The message names the rule, so a model can read it back. */
export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardError";
  }
}

export const GOAL_TEXT_MAX = 2000;
export const TASK_TITLE_MAX = 120;
export const TASK_DESCRIPTION_MAX = 2000;
export const TASK_SUMMARY_MAX = 1000;
export const TASK_BLOCKED_REASON_MAX = 1000;
export const TASK_CHECKPOINT_MAX = 64;
export const TEST_OUTPUT_MAX = 4096;
export const TASK_NOTE_MAX = 4000;
export const GOAL_PLAN_MAX = 4000;
export const GOAL_NOTE_MAX = 4000;

export type NoteKind = "answer" | "held" | "rollback";

/** The moves of the task state table in the goal board spec, section 1. */
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  todo: ["doing", "blocked", "cancelled"],
  doing: ["review", "blocked", "todo", "cancelled"],
  review: ["approval", "doing", "blocked", "cancelled"],
  approval: ["done", "doing", "cancelled"],
  blocked: ["todo", "cancelled"],
  done: ["todo"],
  cancelled: ["todo"],
};

const OPEN: TaskStatus[] = ["todo", "doing", "review", "approval"];

interface GoalRow {
  id: string; project_id: string; text: string; status: GoalStatus; plan: string | null; plan_state: PlanState; plan_by: string | null;
  created_at: string; updated_at: string;
}
interface TaskRow {
  id: string; goal_id: string; parent_id: string | null; project_id: string; title: string; description: string; assignee: string | null;
  deps_json: string; status: TaskStatus; branch: string | null; worktree: string | null; summary: string | null; blocked_reason: string | null; checkpoint: string | null;
  ci: CiState; test_output: string | null; send_backs: number; nudges: number; test_fixes: number; conflicts: number; held: number; held_by_parent: number;
  created_by: string; created_at: string; updated_at: string;
}

const toGoal = (r: GoalRow): Goal => ({
  id: r.id, projectId: r.project_id, text: r.text, status: r.status, plan: r.plan, planState: r.plan_state, planBy: r.plan_by,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toTask = (r: TaskRow): Task => ({
  id: r.id, goalId: r.goal_id, parentId: r.parent_id, projectId: r.project_id, title: r.title, description: r.description, assignee: r.assignee,
  deps: JSON.parse(r.deps_json) as string[], status: r.status, branch: r.branch, worktree: r.worktree, summary: r.summary, blockedReason: r.blocked_reason, checkpoint: r.checkpoint,
  ci: r.ci, testOutput: r.test_output, sendBacks: r.send_backs, nudges: r.nudges, testFixes: r.test_fixes, conflicts: r.conflicts, held: r.held !== 0, heldByParent: r.held_by_parent !== 0,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Sorts `g<n>` and `t<n>` ids by their number, so t10 follows t9. */
const byNumber = <T extends { id: string }>(a: T, b: T): number => Number(a.id.slice(1)) - Number(b.id.slice(1));

/** The state of a team task from its children, spec section 1. */
function teamState(kids: Task[]): TaskStatus {
  const statuses = kids.map((k) => k.status);
  if (statuses.includes("done") && statuses.every((s) => s === "done" || s === "cancelled")) return "done";
  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  if (statuses.some((s) => OPEN.includes(s))) return "doing";
  return "blocked";
}

/**
 * Goals, team tasks and worker tasks of the goal board.
 * Every text is redacted with the stored secrets, then cut to its length, before it is written.
 * `setStatus` is the only way to change a task state outside `update`, and it enforces the state table.
 */
export class BoardStore {
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: string[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Marks a project paused, or resumes it. Pausing a paused project changes nothing. */
  setPaused(projectId: string, paused: boolean): void {
    if (paused) {
      this.db.prepare("INSERT OR IGNORE INTO paused_projects (project_id, since) VALUES (?, ?)").run(projectId, this.stamp());
    } else {
      this.db.prepare("DELETE FROM paused_projects WHERE project_id = ?").run(projectId);
    }
  }

  /** Deletes the project's goals, tasks, runs, notes and paused row. Other projects keep theirs. */
  deleteProject(projectId: string): void {
    this.db.transaction(() => {
      const goals = "SELECT id FROM goals WHERE project_id = ?";
      const tasks = "SELECT id FROM tasks WHERE project_id = ?";
      this.db.prepare(`DELETE FROM task_runs WHERE task_id IN (${tasks})`).run(projectId);
      this.db.prepare(`DELETE FROM task_notes WHERE task_id IN (${tasks})`).run(projectId);
      this.db.prepare(`DELETE FROM goal_notes WHERE goal_id IN (${goals})`).run(projectId);
      this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM goals WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM paused_projects WHERE project_id = ?").run(projectId);
    })();
  }

  /** The distinct branches recorded on the project's tasks. */
  branches(projectId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT branch FROM tasks WHERE project_id = ? AND branch IS NOT NULL ORDER BY branch").all(projectId) as Array<{ branch: string }>).map((r) => r.branch);
  }

  /** The ids of paused projects, sorted. */
  paused(): string[] {
    return (this.db.prepare("SELECT project_id FROM paused_projects ORDER BY project_id").all() as Array<{ project_id: string }>).map((r) => r.project_id);
  }

  createGoal(projectId: string, text: string): Goal {
    const ts = this.stamp();
    const body = this.clip(text, GOAL_TEXT_MAX);
    return this.db.transaction(() => {
      const id = `g${this.nextNumber("goals")}`;
      this.db
        .prepare("INSERT INTO goals (id, project_id, text, status, created_at, updated_at) VALUES (?, ?, ?, 'planning', ?, ?)")
        .run(id, projectId, body, ts, ts);
      return this.goal(id)!;
    })();
  }

  goal(id: string): Goal | undefined {
    const r = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
    return r && toGoal(r);
  }

  goals(projectId: string): Goal[] {
    return (this.db.prepare("SELECT * FROM goals WHERE project_id = ?").all(projectId) as GoalRow[]).map(toGoal).sort(byNumber);
  }

  setGoalStatus(id: string, status: GoalStatus): Goal {
    const r = this.db.prepare("UPDATE goals SET status = ?, updated_at = ? WHERE id = ?").run(status, this.stamp(), id);
    if (r.changes === 0) throw new BoardError(`unknown goal ${id}`);
    return this.goal(id)!;
  }

  /** The team proposes a plan for a goal that is still planning. The plan waits for the player. */
  proposePlan(goalId: string, agentId: string, text: string): Goal {
    return this.db.transaction(() => {
      const goal = this.goal(goalId);
      if (!goal) throw new BoardError(`unknown goal ${goalId}`);
      if (goal.status !== "planning") throw new BoardError(`goal ${goalId} is not planning`);
      this.db
        .prepare("UPDATE goals SET plan = ?, plan_by = ?, plan_state = 'proposed', updated_at = ? WHERE id = ?")
        .run(this.clip(text, GOAL_PLAN_MAX), agentId, this.stamp(), goalId);
      return this.goal(goalId)!;
    })();
  }

  setPlanState(goalId: string, state: PlanState): Goal {
    const r = this.db.prepare("UPDATE goals SET plan_state = ?, updated_at = ? WHERE id = ?").run(state, this.stamp(), goalId);
    if (r.changes === 0) throw new BoardError(`unknown goal ${goalId}`);
    return this.goal(goalId)!;
  }

  /** Planning goals of every project whose plan waits for the player. */
  plansWaiting(): Goal[] {
    const rows = this.db.prepare("SELECT * FROM goals WHERE status = 'planning' AND plan_state = 'proposed'").all() as GoalRow[];
    return rows.map(toGoal);
  }

  createTask(input: {
    goalId: string;
    parentId?: string | null;
    title: string;
    description: string;
    assignee?: string | null;
    deps?: string[];
    createdBy: string;
  }): Task {
    return this.db.transaction(() => {
      const goal = this.goal(input.goalId);
      if (!goal) throw new BoardError(`unknown goal ${input.goalId}`);
      const parentId = input.parentId ?? null;
      if (parentId !== null) {
        const parent = this.task(parentId);
        if (!parent || parent.goalId !== goal.id) throw new BoardError(`unknown parent ${parentId} in ${goal.id}`);
      }
      const deps = input.deps ?? [];
      this.checkDeps(goal.id, parentId, deps, null);
      const ts = this.stamp();
      const id = `t${this.nextNumber("tasks")}`;
      // A task made under a held team task starts held by it, so resuming the team task releases it.
      const held = parentId !== null && this.task(parentId)!.held ? 1 : 0;
      this.db
        .prepare(
          `INSERT INTO tasks (id, goal_id, parent_id, project_id, title, description, assignee, deps_json, status, ci, send_backs, nudges, test_fixes, conflicts, held, held_by_parent, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', 'none', 0, 0, 0, 0, ?, ?, ?, ?, ?)`,
        )
        .run(id, goal.id, parentId, goal.projectId, this.clip(input.title, TASK_TITLE_MAX), this.clip(input.description, TASK_DESCRIPTION_MAX),
          input.assignee ?? null, JSON.stringify(deps), held, held, input.createdBy, ts, ts);
      return this.task(id)!;
    })();
  }

  task(id: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return r && toTask(r);
  }

  /** Every task of the goal, team and worker, in id order. */
  tasks(goalId: string): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE goal_id = ?").all(goalId) as TaskRow[]).map(toTask).sort(byNumber);
  }

  /** The worker tasks of a team task, in id order. */
  children(taskId: string): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE parent_id = ?").all(taskId) as TaskRow[]).map(toTask).sort(byNumber);
  }

  /** Worker tasks in `todo` that are not held, whose own deps and whose team's deps are all `done`, in id order. */
  ready(goalId: string): Task[] {
    const all = this.tasks(goalId);
    const byId = new Map(all.map((t) => [t.id, t]));
    const done = new Set(all.filter((t) => t.status === "done").map((t) => t.id));
    return all.filter((t) => {
      if (t.parentId === null || t.status !== "todo" || t.held) return false;
      const team = byId.get(t.parentId);
      return t.deps.every((d) => done.has(d)) && (team?.deps ?? []).every((d) => done.has(d));
    });
  }

  /** `byParent` marks a hold made by the pause of the team task. A release clears the mark. */
  setHeld(id: string, held: boolean, byParent = false): Task {
    const r = this.db.prepare("UPDATE tasks SET held = ?, held_by_parent = ?, updated_at = ? WHERE id = ?").run(held ? 1 : 0, held && byParent ? 1 : 0, this.stamp(), id);
    if (r.changes === 0) throw new BoardError(`unknown task ${id}`);
    return this.task(id)!;
  }

  update(id: string, patch: TaskPatch): Task {
    return this.db.transaction(() => {
      const task = this.task(id);
      if (!task) throw new BoardError(`unknown task ${id}`);
      const set: string[] = [];
      const args: unknown[] = [];
      const put = (column: string, value: unknown) => {
        set.push(`${column} = ?`);
        args.push(value);
      };
      if (patch.deps !== undefined) {
        this.checkDeps(task.goalId, task.parentId, patch.deps, id);
        put("deps_json", JSON.stringify(patch.deps));
      }
      if (patch.title !== undefined) put("title", this.clip(patch.title, TASK_TITLE_MAX));
      if (patch.description !== undefined) put("description", this.clip(patch.description, TASK_DESCRIPTION_MAX));
      if (patch.assignee !== undefined) put("assignee", patch.assignee);
      if (patch.branch !== undefined) put("branch", patch.branch);
      if (patch.worktree !== undefined) put("worktree", patch.worktree);
      if (patch.summary !== undefined) put("summary", patch.summary === null ? null : this.clip(patch.summary, TASK_SUMMARY_MAX));
      if (patch.blockedReason !== undefined) put("blocked_reason", patch.blockedReason === null ? null : this.clip(patch.blockedReason, TASK_BLOCKED_REASON_MAX));
      if (patch.checkpoint !== undefined) put("checkpoint", patch.checkpoint === null ? null : this.clip(patch.checkpoint, TASK_CHECKPOINT_MAX));
      if (patch.ci !== undefined) put("ci", patch.ci);
      if (patch.testOutput !== undefined) put("test_output", patch.testOutput === null ? null : this.tail(patch.testOutput));
      if (patch.sendBacks !== undefined) put("send_backs", patch.sendBacks);
      if (patch.nudges !== undefined) put("nudges", patch.nudges);
      if (patch.testFixes !== undefined) put("test_fixes", patch.testFixes);
      if (patch.conflicts !== undefined) put("conflicts", patch.conflicts);
      if (set.length > 0) {
        put("updated_at", this.stamp());
        this.db.prepare(`UPDATE tasks SET ${set.join(", ")} WHERE id = ?`).run(...args, id);
      }
      return this.task(id)!;
    })();
  }

  /**
   * Moves a task to `to`. Without `force`, the move must be in the state table, and a worker
   * enters `doing` only with an assignee and every dep `done`. `force` skips both checks.
   */
  setStatus(id: string, to: TaskStatus, opts: { force?: boolean } = {}): Task {
    return this.db.transaction(() => {
      const task = this.task(id);
      if (!task) throw new BoardError(`unknown task ${id}`);
      if (!opts.force) {
        if (!ALLOWED[task.status].includes(to)) throw new BoardError(`${id} cannot move from ${task.status} to ${to}`);
        if (to === "doing" && task.parentId !== null) {
          if (!task.assignee) throw new BoardError(`${id} has no assignee`);
          const pending = task.deps.filter((d) => this.task(d)?.status !== "done");
          if (pending.length > 0) throw new BoardError(`${id} waits for ${pending.join(", ")}`);
        }
      }
      this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(to, this.stamp(), id);
      return this.task(id)!;
    })();
  }

  /** Sets team task states from their children, then the goal state from its team tasks. */
  rollup(goalId: string): void {
    this.db.transaction(() => {
      const goal = this.goal(goalId);
      if (!goal) throw new BoardError(`unknown goal ${goalId}`);
      const all = this.tasks(goalId);
      for (const team of all.filter((t) => t.parentId === null)) {
        const kids = all.filter((t) => t.parentId === team.id);
        if (kids.length === 0) continue;
        const next = teamState(kids);
        if (next !== team.status) this.setStatus(team.id, next, { force: true });
      }
      const teams = this.tasks(goalId).filter((t) => t.parentId === null);
      if (teams.length === 0) return;
      const next: GoalStatus | null = teams.every((t) => t.status === "done") ? "done" : teams.every((t) => t.status === "cancelled") ? "cancelled" : null;
      if (next !== null && next !== goal.status) this.setGoalStatus(goalId, next);
    })();
  }

  /** Every task of every project that waits on the player: blocked, in approval, or failing CI in doing or review. */
  waitingTasks(): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status IN ('blocked', 'approval') OR (status IN ('doing', 'review') AND ci = 'fail')")
      .all() as TaskRow[];
    return rows.map(toTask);
  }

  /** Done worker tasks over all worker tasks that are not cancelled. */
  progress(goalId: string): { done: number; total: number } {
    const workers = this.tasks(goalId).filter((t) => t.parentId !== null && t.status !== "cancelled");
    return { done: workers.filter((t) => t.status === "done").length, total: workers.length };
  }

  addRun(taskId: string, runId: string, kind: RunKind): void {
    this.db.prepare("INSERT OR IGNORE INTO task_runs (task_id, run_id, kind) VALUES (?, ?, ?)").run(taskId, runId, kind);
  }

  runs(taskId: string): Array<{ runId: string; kind: RunKind }> {
    const rows = this.db.prepare("SELECT run_id, kind FROM task_runs WHERE task_id = ? ORDER BY rowid").all(taskId) as Array<{ run_id: string; kind: RunKind }>;
    return rows.map((r) => ({ runId: r.run_id, kind: r.kind }));
  }

  /** A player answer or a held player message for a task. Both outlive a restart. */
  addNote(taskId: string, kind: NoteKind, text: string): void {
    this.db.prepare("INSERT INTO task_notes (task_id, kind, text) VALUES (?, ?, ?)").run(taskId, kind, this.clip(text, TASK_NOTE_MAX));
  }

  notes(taskId: string, kind: NoteKind): string[] {
    return (this.db.prepare("SELECT text FROM task_notes WHERE task_id = ? AND kind = ? ORDER BY id").all(taskId, kind) as Array<{ text: string }>).map((r) => r.text);
  }

  /** The notes of one kind, removed from the store. */
  takeNotes(taskId: string, kind: NoteKind): string[] {
    return this.db.transaction(() => {
      const list = this.notes(taskId, kind);
      this.db.prepare("DELETE FROM task_notes WHERE task_id = ? AND kind = ?").run(taskId, kind);
      return list;
    })();
  }

  /** A player note for a goal's planning. It waits until the team takes it. */
  addGoalNote(goalId: string, text: string): void {
    this.db.prepare("INSERT INTO goal_notes (goal_id, text) VALUES (?, ?)").run(goalId, this.clip(text, GOAL_NOTE_MAX));
  }

  /** The goal's notes with their ids, oldest first. They stay in the store. */
  goalNotes(goalId: string): Array<{ id: number; text: string }> {
    return this.db.prepare("SELECT id, text FROM goal_notes WHERE goal_id = ? ORDER BY id").all(goalId) as Array<{ id: number; text: string }>;
  }

  /** Removes the goal's notes up to and including `upToId`: the ones a plan already answered. */
  clearGoalNotes(goalId: string, upToId: number): void {
    this.db.prepare("DELETE FROM goal_notes WHERE goal_id = ? AND id <= ?").run(goalId, upToId);
  }

  /** The goal's notes, oldest first, removed from the store. */
  takeGoalNotes(goalId: string): string[] {
    return this.db.transaction(() => {
      const list = (this.db.prepare("SELECT text FROM goal_notes WHERE goal_id = ? ORDER BY id").all(goalId) as Array<{ text: string }>).map((r) => r.text);
      this.db.prepare("DELETE FROM goal_notes WHERE goal_id = ?").run(goalId);
      return list;
    })();
  }

  /** Checks deps of a task in `goalId` under `parentId`. `selfId` is set for an update. */
  private checkDeps(goalId: string, parentId: string | null, deps: string[], selfId: string | null): void {
    for (const d of deps) {
      if (d === selfId) throw new BoardError(`self dep: ${d} cannot depend on itself`);
      const dep = this.task(d);
      if (!dep) throw new BoardError(`unknown dep ${d}`);
      if (dep.goalId !== goalId || dep.parentId !== parentId) throw new BoardError(`dep ${d} is not in the same goal and team`);
      if (selfId !== null && this.reaches(d, selfId)) throw new BoardError(`dep ${d} makes a cycle through ${selfId}`);
    }
  }

  /** Whether `target` is reachable from `from` through deps. */
  private reaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(this.task(id)?.deps ?? []));
    }
    return false;
  }

  /** The next number for `g<n>` or `t<n>`. The counter never goes down, so a deleted row's id is never reused. */
  private nextNumber(table: "goals" | "tasks"): number {
    const top = (this.db.prepare(`SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) AS n FROM ${table}`).get() as { n: number }).n;
    const kept = (this.db.prepare("SELECT n FROM id_counters WHERE name = ?").get(table) as { n: number } | undefined)?.n ?? 0;
    const next = Math.max(top, kept) + 1;
    this.db.prepare("INSERT INTO id_counters (name, n) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET n = excluded.n").run(table, next);
    return next;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Redacts first, then cuts, so a secret cut at the limit cannot leak a prefix. */
  private clip(text: string, max: number): string {
    return redact(text, this.secrets).slice(0, max);
  }

  /** Keeps the last TEST_OUTPUT_MAX characters of redacted output. */
  private tail(text: string): string {
    return redact(text, this.secrets).slice(-TEST_OUTPUT_MAX);
  }
}
