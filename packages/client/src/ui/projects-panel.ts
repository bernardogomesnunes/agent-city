import type { ClientMsg, DecisionView, DiffFileView, FileTree, GoalView, HqConfig, LogRow, TaskView } from "@agentcity/world/shared";
import { managerOf, taskChatAgent } from "./chat-agent.js";
import { el } from "./dom.js";
import type { Send } from "./hq-panel.js";
import type { HqDo } from "./hq-settings.js";
import { button as plainButton, diffLines, keepScroll, renderThread } from "./task-thread.js";

export type AgentConfigView = HqConfig["agents"][number];
type ProjectConfigView = HqConfig["projects"][number];

/** What a Chat button asks the dock to open: a new chat with this agent about a task or a goal. */
export interface ChatRef {
  agentId: string;
  projectId: string;
  taskId?: string;
  goalId?: string;
}

/** Everything the panel draws. The owner builds it from the HQ config, the board messages, the decisions list and the paused ids. */
export interface PanelState {
  config: HqConfig | null;
  boards: ReadonlyMap<string, { goals: GoalView[]; tasks: TaskView[] }>;
  decisions: readonly DecisionView[];
  paused: readonly string[];
}

export interface ProjectsHooks {
  chat(ref: ChatRef): void;
  run: HqDo;
}

/** The project id rule of the CLI. */
const NAME_RE = /^[a-z0-9-]{1,32}$/;
const DELETE_TEXT = "Runs stop. Goals, tasks and agent branches leave the city. The folder stays on disk.";
/** How many log rows of the open task stay in memory. */
const MAX_LOG = 500;
/** The panel rebuilds at most this often under a stream of log rows. */
const REDRAW_GATE_MS = 100;
const NO_BOARD = { goals: [] as GoalView[], tasks: [] as TaskView[] };
/** The watch set of each send function. Panels that share a send share the set, so board.watch goes out once per project. */
const WATCHES = new WeakMap<Send, Set<string>>();
const watchesOf = (send: Send): Set<string> => {
  let set = WATCHES.get(send);
  if (!set) WATCHES.set(send, (set = new Set<string>()));
  return set;
};
const WORKING = new Set<TaskView["status"]>(["doing", "review"]);
const BACKLOG = new Set<TaskView["status"]>(["todo", "blocked", "approval"]);
/** Goals still in progress. Every other goal sits in Past goals. */
const ACTIVE = new Set<GoalView["status"]>(["planning", "active"]);
const DOT: Record<TaskView["status"], string> = {
  doing: "run", review: "run", approval: "ask", blocked: "block", todo: "idle", done: "done", cancelled: "idle",
};
const GOAL_DOT: Record<GoalView["status"], string> = { planning: "idle", active: "run", done: "done", cancelled: "idle", failed: "block" };
/** The tabs of level 4. The Thread tab is the task thread with its footer. */
type Tab = "thread" | "diff" | "files" | "preview";
const TABS: Array<[Tab, string]> = [["thread", "Thread"], ["diff", "Diff"], ["files", "Files"], ["preview", "Preview"]];
const EMPTY_FILES: FileTree = { entries: [], truncated: false };

/**
 * The parts of level 4 that stay in place across redraws. The preview frame lives in its pane, so a redraw
 * that moved it would reload the page in the frame.
 */
interface TaskShell {
  taskId: string;
  top: HTMLElement;
  tabBar: HTMLElement;
  panes: Record<Tab, HTMLElement>;
  /** The diff and index last painted, so a redraw paints the diff only when it changed. */
  diffPainted: { files: DiffFileView[] | null; index: number } | null;
  /** The file tree and shown file last painted. */
  filesPainted: { tree: FileTree | null; shown: FileShown | null } | null;
  /** True once the Preview pane was built for this task. */
  previewBuilt: boolean;
}

/** The file picked in the Files tab, with the text the view shows for it. */
interface FileShown {
  path: string;
  body: string;
}

/** What the task fields say about its merge: merged once done with a branch, waiting while review or approval holds a branch, else unknown. */
export function mergeState(t: TaskView): string {
  if (t.branch === null) return "";
  if (t.status === "done") return "merged";
  return t.status === "review" || t.status === "approval" ? "waiting to merge" : "";
}

export { managerOf };

/** Done and total of some tasks, counted from the task views: cancelled tasks do not count. */
function counts(tasks: TaskView[]): { done: number; total: number } {
  const live = workTasks(tasks).filter((t) => t.status !== "cancelled");
  return { done: live.filter((t) => t.status === "done").length, total: live.length };
}

/** The dot of a goal: amber while its plan waits for the player, else by its status. */
function goalDot(g: GoalView): string {
  return g.planState === "proposed" ? "ask" : GOAL_DOT[g.status];
}

/** `waiting on <title>` for a todo task whose dependency is blocked. Empty for any other task. */
export function waitingOn(t: TaskView, tasks: TaskView[]): string {
  if (t.status !== "todo") return "";
  const blocked = tasks.find((d) => t.deps.includes(d.id) && d.status === "blocked");
  return blocked ? `waiting on ${blocked.title}` : "";
}

/** The tasks agents work on: workers, and team tasks not split into workers yet. A team task that has workers only groups them. */
function workTasks(tasks: TaskView[]): TaskView[] {
  const parents = new Set(tasks.map((t) => t.parentId));
  return tasks.filter((t) => t.parentId !== null || !parents.has(t.id));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` names `name` as a word, with a hyphen or a space between its parts. */
function mentions(text: string, name: string): boolean {
  const n = name.toLowerCase();
  return [n, n.replace(/[-_]/g, " ")].some((v) => new RegExp(`(^|[^a-z0-9])${escapeRe(v)}([^a-z0-9]|$)`).test(text));
}

interface Draft {
  name: string;
  folder: string;
  goal: string;
  /** Null until the player touches a box: every agent is chosen. */
  agents: Set<string> | null;
  /** Steps that already ran, so a retry after a failure does not repeat them. */
  done: Set<string>;
  status: { text: string; bad: boolean };
  busy: boolean;
}

const newDraft = (): Draft => ({ name: "", folder: "", goal: "", agents: null, done: new Set(), status: { text: "", bad: false }, busy: false });

/**
 * HQ Work, left column. Level 1 lists the projects. Level 2 is one project: its progress, active goals, Past goals
 * and a goal box. Level 3 is one goal: its plan, and its tasks by state. Level 4 is one task (filled by openTask).
 * The New project form and the delete confirm replace the view in place.
 * Sends board.watch for every project, so the board data keeps coming.
 */
export class ProjectsPanel {
  readonly root: HTMLElement;
  private s: PanelState = { config: null, boards: new Map(), decisions: [], paused: [] };
  private project: string | null = null;
  private goal: string | null = null;
  private task: string | null = null;
  private view: "list" | "new" = "list";
  private confirming = false;
  private deleting = false;
  private deleteError = "";
  private note = "";
  /** Past goals fold on level 2. Closed by default. */
  private pastOpen = false;
  /** The plan fold on level 3. Closed by default. */
  private planOpen = false;
  /** The typed reason of a plan answer, kept across redraws. */
  private planText = "";
  private drawn = "";
  /** The projects this connection already watches. Shared by every panel on the same send, so each project gets one board.watch. */
  private readonly watching: Set<string>;
  private readonly goalDrafts = new Map<string, string>();
  private draft = newDraft();
  /** The open task's log, diff and files, from task.detail, task.log, diff and file messages. */
  private detail: { task: TaskView | null; log: LogRow[]; diff: DiffFileView[] | null; files: FileTree; previewKey: string; hasIndex: boolean } = {
    task: null, log: [], diff: null, files: EMPTY_FILES, previewKey: "", hasIndex: false,
  };
  /** The tab of level 4 on show. */
  private tab: Tab = "thread";
  /** The index of the file the Diff tab shows. */
  private diffIndex = 0;
  /** The file the Files tab shows. */
  private fileShown: FileShown | null = null;
  /** The panes of the open task. Null when level 4 is not drawn. */
  private shell: TaskShell | null = null;
  private rev = 0;
  /** The timer that draws the rows appended since the last draw, null when none waits. */
  private frame: ReturnType<typeof setTimeout> | null = null;
  /** When the panel last rebuilt, for the redraw gate. */
  private lastDraw = 0;
  private threadBox: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private createBtn: HTMLButtonElement | null = null;

  constructor(parent: HTMLElement, private readonly send: Send, private readonly hooks: ProjectsHooks) {
    this.root = el("div", "projects-panel", "", parent);
    this.watching = watchesOf(send);
  }

  get level(): 1 | 2 | 3 | 4 {
    return this.task !== null ? 4 : this.goal !== null ? 3 : this.project !== null ? 2 : 1;
  }

  /** Goes to a project (level 2), or to one of its tasks. An unknown project leaves the list showing. */
  open(projectId?: string, taskId?: string): void {
    if (projectId === undefined) return;
    this.cancelFrame();
    const known = this.s.config === null || this.s.config.projects.some((p) => p.id === projectId);
    this.project = known ? projectId : null;
    this.goal = null;
    this.leaveTask();
    this.view = "list";
    this.confirming = false;
    this.deleteError = "";
    if (known && taskId !== undefined) this.openTask(projectId, taskId);
    this.draw(true);
  }

  /** Goes to one goal of a project (level 3). Its plan fold starts closed. */
  openGoal(projectId: string, goalId: string): void {
    this.cancelFrame();
    this.project = projectId;
    this.goal = goalId;
    this.leaveTask();
    this.view = "list";
    this.confirming = false;
    this.deleteError = "";
    this.planOpen = false;
    this.planText = "";
    this.draw(true);
  }

  /** Opens one task (level 4) and asks the server for its log. The task's goal becomes the Back target when the board knows it. */
  openTask(projectId: string, taskId: string): void {
    this.cancelFrame();
    this.leaveTask();
    this.project = projectId;
    this.goal = this.s.boards.get(projectId)?.tasks.find((t) => t.id === taskId)?.goalId ?? null;
    this.task = taskId;
    this.view = "list";
    this.confirming = false;
    this.detail = { task: null, log: [], diff: null, files: EMPTY_FILES, previewKey: "", hasIndex: false };
    this.send({ type: "task.open", taskId });
    this.draw(true);
  }

  /** Forgets the open task's panes, tab and picks. The next task starts on the Thread tab. */
  private leaveTask(): void {
    this.task = null;
    this.shell = null;
    this.threadBox = null;
    this.tab = "thread";
    this.diffIndex = 0;
    this.fileShown = null;
  }

  /** The log, tree and preview of the open task, from task.detail. The first one also asks for the diff. Ignored for any other task. */
  setDetail(task: TaskView, log: LogRow[], files: FileTree = EMPTY_FILES, previewKey = "", hasIndex = false): void {
    if (task.id !== this.task) return;
    const first = this.detail.task === null;
    this.detail = { ...this.detail, task, log: log.slice(-MAX_LOG), files, previewKey, hasIndex };
    this.rev++;
    if (first) this.send({ type: "diff.request", taskId: task.id });
    this.draw(false);
  }

  /** One file of the open task, picked in the Files tab. Text goes in as text, never as markup. Ignored for any other task. */
  setFile(taskId: string, path: string, f: { text?: string; binary: boolean; truncated: boolean; error?: string }): void {
    if (taskId !== this.task) return;
    const head = f.error ? `${path}: ${f.error}` : f.binary ? `${path}: binary file` : `${path}${f.truncated ? " (cut at 200 KB)" : ""}`;
    this.fileShown = { path, body: f.text === undefined ? head : `${head}\n\n${f.text}` };
    this.rev++;
    this.draw(false);
  }

  /** New log rows of the open task. Memory keeps the last 500. Rows that arrive together draw once, and the panel rebuilds at most once per 100 ms. */
  appendLog(taskId: string, rows: LogRow[]): void {
    if (taskId !== this.task) return;
    this.detail = { ...this.detail, log: [...this.detail.log, ...rows].slice(-MAX_LOG) };
    this.rev++;
    if (this.frame === null) {
      this.frame = setTimeout(() => {
        this.frame = null;
        this.draw(false);
      }, Math.max(0, REDRAW_GATE_MS - (Date.now() - this.lastDraw)));
    }
  }

  /** HQ closed: a redraw that waits has nothing to show. */
  close(): void {
    this.cancelFrame();
  }

  /** The panel leaves the screen: a redraw that waits is dropped, and the next visit starts at level 1. */
  leave(): void {
    this.cancelFrame();
    this.project = null;
    this.goal = null;
    this.leaveTask();
    this.view = "list";
    this.confirming = false;
    this.deleteError = "";
    this.draw(true);
  }

  private cancelFrame(): void {
    if (this.frame !== null) clearTimeout(this.frame);
    this.frame = null;
  }

  /** The diff of the open task. */
  setDiff(taskId: string, files: DiffFileView[]): void {
    if (taskId !== this.task) return;
    this.detail = { ...this.detail, diff: files };
    this.rev++;
    this.draw(false);
  }

  /** Asks again for the board of every project. Called when HQ opens, after a reconnect may have dropped the watches. */
  watchAll(): void {
    this.watching.clear();
    this.watchNew();
  }

  render(s: PanelState): void {
    this.s = s;
    this.watchNew();
    if (this.project !== null && s.config && !s.config.projects.some((p) => p.id === this.project)) {
      // The open project was deleted or removed: back to the list.
      this.cancelFrame();
      this.project = null;
      this.goal = null;
      this.leaveTask();
      this.confirming = false;
      this.deleting = false;
    } else if (this.goal !== null && this.project !== null && s.boards.has(this.project)) {
      // The open goal was removed: back to the project. A goal not on a loaded board is only waiting.
      const goals = s.boards.get(this.project)!.goals;
      if (!goals.some((g) => g.id === this.goal)) {
        this.cancelFrame();
        this.goal = null;
        this.leaveTask();
      }
    }
    if (this.task !== null && this.project !== null && s.boards.has(this.project)) {
      // The open task is not on its loaded board: it was deleted. Back to its goal.
      if (!s.boards.get(this.project)!.tasks.some((t) => t.id === this.task)) {
        this.cancelFrame();
        this.leaveTask();
      }
    }
    this.draw(false);
  }

  private watchNew(): void {
    for (const p of this.s.config?.projects ?? []) {
      if (this.watching.has(p.id)) continue;
      if (this.send({ type: "board.watch", projectId: p.id })) this.watching.add(p.id);
    }
  }

  private nameOf(id: string): string {
    return this.s.config?.agents.find((a) => a.id === id)?.name ?? id;
  }

  /** The agents a project grants. */
  private agentsOf(p: ProjectConfigView): AgentConfigView[] {
    return (this.s.config?.agents ?? []).filter((a) => p.agents.includes(a.id));
  }

  private go(project: string | null, view: "list" | "new" = "list"): void {
    this.cancelFrame();
    this.project = project;
    this.goal = null;
    this.leaveTask();
    this.view = view;
    this.confirming = false;
    this.deleteError = "";
    if (project !== null) this.note = "";
    this.draw(true);
  }

  /** Back one level from a goal or a task. */
  private up(): void {
    this.cancelFrame();
    if (this.task !== null) this.leaveTask();
    else this.goal = null;
    this.confirming = false;
    this.deleteError = "";
    this.draw(true);
  }

  /** Redraws when what the view shows changed. Typing in a form is not disturbed by board updates. */
  private draw(force: boolean): void {
    const c = this.s.config;
    const key = this.view === "new"
      ? JSON.stringify(["new", c?.agents, c?.skills, c?.mcpServers, c?.projects.map((p) => p.id)])
      : JSON.stringify([
        this.project, this.goal, this.task, this.rev, this.confirming, this.deleting, this.deleteError, this.note, this.view, this.pastOpen,
        this.planOpen, this.planText, c, [...this.s.boards], this.s.decisions, this.s.paused,
      ]);
    if (!force && key === this.drawn) return;
    this.drawn = key;
    this.lastDraw = Date.now();
    const active = document.activeElement;
    const keep = active instanceof HTMLElement && this.root.contains(active) ? active.dataset.keep : undefined;
    const sel = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;
    if (this.threadBox) keepScroll(this.threadBox);
    // Level 4 with the same task keeps its panes in place: the preview frame must not be moved or removed.
    const reuse = c !== null && this.shell !== null && this.view === "list" && !this.confirming
      && this.shell.taskId === this.task && this.root.contains(this.shell.top);
    if (!reuse) {
      this.shell = null;
      this.root.replaceChildren();
    }
    if (!c) el("div", "ac-empty", "loading…", this.root);
    else if (this.view === "new") this.drawForm(c);
    else if (this.project !== null && this.task !== null) this.drawTask(c.projects.find((p) => p.id === this.project)!, this.task);
    else if (this.project !== null && this.goal !== null) this.drawGoal(c.projects.find((p) => p.id === this.project)!, this.goal);
    else if (this.project !== null) this.drawProject(c.projects.find((p) => p.id === this.project)!);
    else this.drawList(c);
    if (keep) {
      const again = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-keep="${keep}"]`);
      again?.focus();
      if (again && sel?.[0] != null && sel[1] != null) again.setSelectionRange(sel[0], sel[1]);
    }
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
    const b = el("button", `ac-button ${cls}`.trim(), label, parent);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  private back(parent: HTMLElement): void {
    this.button(parent, "‹ Projects", () => this.go(null), "hq-back pp-back");
  }

  // ---- level 1

  private drawList(c: HqConfig): void {
    if (this.note) el("div", "pp-note", this.note, this.root);
    const bar = el("div", "hq-pane-bar", "", this.root);
    el("span", "hq-row-sub", c.projects.length === 0 ? "" : `${c.projects.length} project(s)`, bar);
    this.button(bar, "New project", () => {
      this.note = "";
      this.go(null, "new");
    }, "approve pp-new");
    if (c.projects.length === 0) return void el("div", "ac-empty", "Start your first project", this.root);
    for (const p of c.projects) this.drawRow(p);
    el("div", "ac-sec", "Legend", this.root);
    const legend = el("div", "pp-legend", "", this.root);
    for (const [cls, label] of [["run", "working"], ["ask", "needs you"], ["block", "blocked"], ["idle", "idle"], ["done", "done"]] as const) {
      const item = el("span", "pp-legend-item", "", legend);
      el("span", `st-dot ${cls}`, "", item);
      item.append(` ${label}`);
    }
  }

  private drawRow(p: ProjectConfigView): void {
    const board = this.s.boards.get(p.id) ?? NO_BOARD;
    const { done, total } = counts(board.tasks);
    const work = workTasks(board.tasks);
    const working = work.filter((t) => t.status === "doing" && !t.held).length;
    const inbox = this.s.decisions.filter((d) => d.projectId === p.id).length;
    const paused = this.s.paused.includes(p.id);
    const blocked = work.some((t) => t.status === "blocked");
    const dot = paused ? "idle" : inbox > 0 ? "ask" : blocked ? "block" : working > 0 ? "run" : "idle";
    const row = el("button", "pp-row", "", this.root);
    row.type = "button";
    el("span", `st-dot ${dot}`, "", row);
    el("span", "pp-name", p.id, row);
    el("span", "pp-sub", `${done} of ${total} done`, row);
    if (working > 0) el("span", "pp-sub", `${working} working`, row);
    if (inbox > 0) el("span", "pp-inbox", String(inbox), row).title = `${inbox} waiting in the Inbox`;
    if (paused) el("span", "pp-paused", "paused", row);
    row.addEventListener("click", () => this.go(p.id));
  }

  // ---- level 2

  private drawProject(p: ProjectConfigView): void {
    const board = this.s.boards.get(p.id) ?? NO_BOARD;
    const paused = this.s.paused.includes(p.id);
    if (this.confirming) return this.drawConfirm(p);

    const top = el("div", "pp-top", "", this.root);
    this.back(top);
    el("span", "pp-spacer", "", top);
    this.button(top, paused ? "Resume" : "Pause", () => this.send({ type: "project.pause", projectId: p.id, paused: !paused }));
    this.button(top, "Delete", () => {
      this.confirming = true;
      this.draw(true);
    }, "deny");

    const { done, total } = counts(board.tasks);
    const head = el("div", "pp-head", "", this.root);
    el("span", "ac-title pp-title", p.id, head);
    el("span", "pp-sub", `${done} of ${total} done`, head);
    if (paused) el("span", "pp-paused", "paused", head);
    const bar = el("div", "pp-bar", "", this.root);
    el("div", "pp-bar-fill", "", bar).style.width = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;

    const active = board.goals.filter((g) => ACTIVE.has(g.status));
    const past = board.goals.filter((g) => !ACTIVE.has(g.status));
    const goals = el("div", "pp-section", "", this.root);
    el("div", "ac-sec", "Goals", goals);
    if (board.goals.length === 0) el("div", "ac-empty", "no goals yet", goals);
    for (const g of active) this.goalRow(goals, p, g, board);
    if (past.length > 0) {
      const fold = this.button(goals, `Past goals (${past.length})`, () => {
        this.pastOpen = !this.pastOpen;
        this.draw(true);
      }, "pp-fold");
      fold.setAttribute("aria-expanded", String(this.pastOpen));
      if (this.pastOpen) for (const g of past) this.goalRow(goals, p, g, board);
    }

    const box = el("div", "pp-goal-box", "", this.root);
    const input = el("input", "pp-goal-input", "", box);
    input.placeholder = "A goal for the team";
    input.maxLength = 2000;
    input.dataset.keep = "goal";
    input.value = this.goalDrafts.get(p.id) ?? "";
    input.addEventListener("input", () => this.goalDrafts.set(p.id, input.value));
    const submit = () => {
      const text = input.value.trim();
      if (text === "") return;
      if (!this.send({ type: "goal.submit", projectId: p.id, text })) return;
      this.goalDrafts.delete(p.id);
      input.value = "";
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    this.button(box, "Submit goal", submit, "approve");
  }

  /** One goal on level 2: the row opens it, Chat talks to the goal's Manager. */
  private goalRow(parent: HTMLElement, p: ProjectConfigView, g: GoalView, board: { goals: GoalView[]; tasks: TaskView[] }): void {
    const row = el("div", "pp-goal", "", parent);
    const open = el("button", "pp-goal-open", "", row);
    open.type = "button";
    el("span", `st-dot ${goalDot(g)}`, "", open);
    el("span", "pp-goal-text", g.text, open);
    const gc = counts(board.tasks.filter((t) => t.goalId === g.id));
    el("span", "pp-sub", `${gc.done} of ${gc.total} done`, open);
    open.addEventListener("click", () => this.openGoal(p.id, g.id));
    const manager = managerOf(g, board.tasks, this.agentsOf(p), this.s.config?.agents);
    if (manager) {
      this.button(row, `Chat · ${this.nameOf(manager)}`, () => this.hooks.chat({ agentId: manager, projectId: p.id, goalId: g.id }), "pp-chat");
    }
  }

  // ---- level 3

  private drawGoal(p: ProjectConfigView, goalId: string): void {
    const board = this.s.boards.get(p.id) ?? NO_BOARD;
    const top = el("div", "pp-top", "", this.root);
    const g = board.goals.find((x) => x.id === goalId);
    this.button(top, `‹ ${p.id}`, () => this.up(), "hq-back pp-back");
    if (!g) {
      // Once the board is in, a goal id that is not on it is gone. Before that it may still come.
      el("div", "ac-empty", this.s.boards.has(p.id) ? "This goal is gone" : "loading…", this.root);
      return;
    }
    const goalTasks = board.tasks.filter((t) => t.goalId === g.id);
    const { done, total } = counts(goalTasks);
    const head = el("div", "pp-head", "", this.root);
    el("span", "ac-title pp-title", g.text, head);
    el("span", "pp-sub", `${g.planState === "proposed" ? "waiting for your OK" : g.status} · ${done} of ${total} done`, head);
    const bar = el("div", "pp-bar", "", this.root);
    el("div", "pp-bar-fill", "", bar).style.width = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;

    if (g.plan !== null) {
      const fold = this.button(this.root, "Plan", () => {
        this.planOpen = !this.planOpen;
        this.draw(true);
      }, "pp-fold");
      fold.setAttribute("aria-expanded", String(this.planOpen));
      if (this.planOpen) el("div", "pp-plan", g.plan, this.root);
    }
    if (g.planState === "proposed") this.drawPlanAnswer(g);

    const shown = workTasks(goalTasks);
    const agents = this.agentsOf(p);
    this.taskSection("Working now", shown.filter((t) => WORKING.has(t.status)), goalTasks, board, agents, p.id);
    this.taskSection("Backlog", shown.filter((t) => BACKLOG.has(t.status)), goalTasks, board, agents, p.id);
    this.taskSection("Delivered", shown.filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), goalTasks, board, agents, p.id);
  }

  /** The three answers to a plan that waits. Changes and reject take the typed reason when there is one. */
  private drawPlanAnswer(g: GoalView): void {
    const box = el("div", "pp-plan-answer", "", this.root);
    const text = el("textarea", "pp-plan-text", "", box);
    text.placeholder = "What should change?";
    text.maxLength = 4000;
    text.value = this.planText;
    text.addEventListener("input", () => (this.planText = text.value));
    const answer = (option: "approve" | "changes" | "reject") => {
      const reason = this.planText.trim();
      if (option === "changes" && reason === "") return;
      const msg: ClientMsg = { type: "plan.answer", goalId: g.id, option, ...(reason ? { text: reason } : {}) };
      if (this.send(msg)) this.planText = "";
    };
    this.button(box, "Approve", () => answer("approve"), "approve");
    this.button(box, "Request changes", () => answer("changes"));
    this.button(box, "Reject", () => answer("reject"), "deny");
  }

  /**
   * One section of level 3. A worker row sits under its team's label. A team with no workers is a row of its own,
   * with its status. The label appears once per section.
   */
  private taskSection(
    title: string, list: TaskView[], goalTasks: TaskView[], board: { goals: GoalView[]; tasks: TaskView[] }, agents: AgentConfigView[], projectId: string,
  ): void {
    if (list.length === 0) return;
    const sec = el("div", "pp-section", "", this.root);
    el("div", "ac-sec", title, sec);
    const labelled = new Set<string>();
    for (const t of list) {
      if (t.parentId !== null) {
        const team = goalTasks.find((x) => x.id === t.parentId);
        if (team && !labelled.has(team.id)) {
          labelled.add(team.id);
          el("div", "pp-team", team.title, sec);
        }
      }
      this.taskRow(sec, t, board, agents, projectId);
    }
  }

  private taskRow(parent: HTMLElement, t: TaskView, board: { goals: GoalView[]; tasks: TaskView[] }, agents: AgentConfigView[], projectId: string): void {
    const row = el("div", t.parentId !== null ? "pp-task pp-worker" : "pp-task", "", parent);
    const open = el("button", "pp-task-open", "", row);
    open.type = "button";
    el("span", `st-dot ${DOT[t.status]}`, "", open);
    el("span", "pp-task-title", t.title, open);
    // Only a delivered row speaks of the merge. Every row falls back to its assignee.
    const merge = t.status === "done" ? mergeState(t) : "";
    const waiting = waitingOn(t, board.tasks);
    if (merge) el("span", "pp-sub", merge, open);
    else if (waiting) el("span", "pp-sub", waiting, open);
    else if (t.assignee) el("span", "pp-sub", this.nameOf(t.assignee), open);
    if (t.held) el("span", "pp-paused", "paused", open);
    open.addEventListener("click", () => this.openTask(projectId, t.id));
    this.button(row, "Chat", () => {
      const agentId = this.chatAgent(t, board, agents);
      if (agentId) this.hooks.chat({ agentId, projectId, taskId: t.id });
    }, "pp-chat");
  }

  /** The agent a task Chat opens: the assignee when the city knows it, else the manager of the task's goal. */
  private chatAgent(t: TaskView, board: { goals: GoalView[]; tasks: TaskView[] }, agents: AgentConfigView[]): string {
    return taskChatAgent(t, board, { project: agents, city: this.s.config?.agents ?? [] });
  }

  // ---- level 4

  private drawTask(p: ProjectConfigView, taskId: string): void {
    const board = this.s.boards.get(p.id) ?? NO_BOARD;
    const g = this.goal === null ? undefined : board.goals.find((x) => x.id === this.goal);
    const back = { label: `‹ ${g ? g.text : p.id}`, go: () => this.up() };
    // The log's task stands in only until the board loads. After that a task missing from the board is gone.
    const task = board.tasks.find((t) => t.id === taskId) ?? (this.s.boards.has(p.id) ? null : this.detail.task);
    if (!task) {
      this.shell = null;
      this.root.replaceChildren();
      this.button(el("div", "pp-top", "", this.root), back.label, back.go, "hq-back pp-back");
      // Once the board is in, a task id that is not on it is gone. Before that it may still come.
      el("div", "ac-empty", this.s.boards.has(p.id) ? "This task is gone" : "loading…", this.root);
      return;
    }
    const s = this.shell ?? (this.shell = this.buildShell(task.id));
    this.paintTask(p, task, s, back, board);
  }

  /** The parts of level 4 for one task: the back link, the tab bar and the four panes. Built once per open task. */
  private buildShell(taskId: string): TaskShell {
    const top = el("div", "pp-top", "", this.root);
    const tabBar = el("div", "pp-tabs", "", this.root);
    const panes = {} as Record<Tab, HTMLElement>;
    panes.thread = el("div", "task-thread pp-pane", "", this.root);
    panes.diff = el("div", "pp-pane", "", this.root);
    panes.files = el("div", "pp-pane", "", this.root);
    panes.preview = el("div", "pp-pane", "", this.root);
    for (const [tab] of TABS) panes[tab].dataset.pane = tab;
    this.threadBox = panes.thread;
    return { taskId, top, tabBar, panes, diffPainted: null, filesPainted: null, previewBuilt: false };
  }

  /** Fills the parts of level 4. Only the shown tab's pane is painted in full; the hidden panes keep their state. */
  private paintTask(
    p: ProjectConfigView, task: TaskView, s: TaskShell, back: { label: string; go: () => void }, board: { goals: GoalView[]; tasks: TaskView[] },
  ): void {
    s.top.replaceChildren();
    this.button(s.top, back.label, back.go, "hq-back pp-back");
    s.tabBar.replaceChildren();
    for (const [tab, label] of TABS) {
      plainButton(s.tabBar, label, () => this.selectTab(tab), `ac-tab pp-tab${tab === this.tab ? " active" : ""}`);
    }
    for (const [tab] of TABS) s.panes[tab].hidden = tab !== this.tab;

    const agent = this.s.config?.agents.find((a) => a.id === task.assignee);
    const chatAgent = this.chatAgent(task, board, this.agentsOf(p));
    renderThread(s.panes.thread, task, this.detail.log, this.send, {
      ...(agent ? { agentName: agent.name, role: agent.role } : {}),
      ...(chatAgent ? { chatAgent } : {}),
      chat: (ref) => this.hooks.chat(ref),
      // The Diff tab shows the changes, so the thread leaves its Changes list out.
      changes: false,
      loading: this.detail.task === null,
    });
    if (this.tab === "diff") this.paintDiff(s);
    else if (this.tab === "files") this.paintFiles(s, task);
    else if (this.tab === "preview") this.paintPreview(s, task);
  }

  /** A tab click: the Diff tab asks the server for the diff again. */
  private selectTab(tab: Tab): void {
    this.tab = tab;
    if (tab === "diff" && this.task !== null) this.send({ type: "diff.request", taskId: this.task });
    this.draw(true);
  }

  /** The Diff tab: the files of the diff on the left, the chosen file's lines on the right. Repainted only when the diff or the choice changed. */
  private paintDiff(s: TaskShell): void {
    const files = this.detail.diff;
    const index = this.diffIndex;
    if (s.diffPainted !== null && s.diffPainted.files === files && s.diffPainted.index === index) return;
    s.diffPainted = { files, index };
    const pane = s.panes.diff;
    pane.replaceChildren();
    if (files === null) return void el("div", "ac-empty", "loading diff…", pane);
    if (files.length === 0) return void el("div", "ac-empty", "no file changes", pane);
    const view = el("div", "pp-diff", "", pane);
    const list = el("div", "", "", view);
    const picked = Math.min(index, files.length - 1);
    files.forEach((f, i) => {
      plainButton(list, `${f.path} +${f.additions} -${f.deletions}`, () => {
        this.diffIndex = i;
        this.draw(true);
      }, `ac-tab diff-file${i === picked ? " active" : ""}`);
    });
    const file = files[picked]!;
    const lines = el("div", "diff-lines", "", view);
    el("div", "hq-row-sub", `${file.status}${file.truncated ? " · cut" : ""}`, lines);
    diffLines(lines, file);
  }

  /** The Files tab: the tree of the task's worktree. A file click asks for its text. Repainted only when the tree or the shown file changed. */
  private paintFiles(s: TaskShell, task: TaskView): void {
    const tree = this.detail.files;
    const shown = this.fileShown;
    if (s.filesPainted !== null && s.filesPainted.tree === tree && s.filesPainted.shown === shown) return;
    s.filesPainted = { tree, shown };
    const pane = s.panes.files;
    pane.replaceChildren();
    if (tree.error) el("div", "ac-empty", tree.error, pane);
    if (tree.entries.length === 0 && !tree.error) el("div", "ac-empty", "no files", pane);
    for (const e of tree.entries) {
      const parts = e.path.split(/[\\/]/);
      const row = el("div", e.dir ? "pp-file" : "pp-file pp-file-pick", `${parts[parts.length - 1]}${e.dir ? "/" : ""}`, pane);
      row.style.paddingLeft = `${(parts.length - 1) * 12}px`;
      if (!e.dir) {
        row.addEventListener("click", () => {
          this.fileShown = { path: e.path, body: "loading…" };
          this.send({ type: "file.request", taskId: task.id, path: e.path });
          this.draw(true);
        });
      }
    }
    if (tree.truncated) el("div", "diff-cut", "list cut", pane);
    if (shown) el("pre", "pp-file-view", shown.body, pane);
  }

  /** The Preview tab: the task's own index.html in a sandboxed frame. Built on the first show, then kept, so a redraw does not reload it. */
  private paintPreview(s: TaskShell, task: TaskView): void {
    if (s.previewBuilt) return;
    const pane = s.panes.preview;
    pane.replaceChildren();
    if (this.detail.task === null) return void el("div", "ac-empty", "loading…", pane);
    s.previewBuilt = true;
    if (!this.detail.hasIndex) return void el("div", "ac-empty", "no index.html in this task", pane);
    const frame = el("iframe", "work-frame", "", pane);
    frame.title = "preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("src", `/p/${encodeURIComponent(this.detail.previewKey)}/${encodeURIComponent(task.id)}/`);
  }

  private drawConfirm(p: ProjectConfigView): void {
    const box = el("div", "pp-confirm", "", this.root);
    const text = el("div", "pp-confirm-text", "", box);
    text.append(el("span", "pp-confirm-head", `Delete ${p.id}?`), ` ${DELETE_TEXT}`);
    if (p.workspace) el("div", "ac-mono pp-sub", p.workspace, box);
    if (this.deleteError) el("div", "pp-error", this.deleteError, box);
    const buttons = el("div", "pp-buttons", "", box);
    const del = this.button(buttons, this.deleting ? "Deleting…" : "Delete", () => void this.remove(p.id), "deny");
    const keep = this.button(buttons, "Keep", () => {
      this.confirming = false;
      this.deleteError = "";
      this.draw(true);
    });
    del.disabled = keep.disabled = this.deleting;
  }

  private async remove(id: string): Promise<void> {
    if (this.deleting) return;
    this.deleting = true;
    this.deleteError = "";
    this.draw(true);
    let r: { code: number; text: string };
    try {
      r = await this.hooks.run(["project", "remove", id]);
    } catch (e) {
      r = { code: 1, text: e instanceof Error ? e.message : String(e) };
    }
    this.deleting = false;
    if (r.code === 0) {
      this.note = r.text;
      this.confirming = false;
      if (this.project === id) this.project = null;
      this.goal = null;
      this.leaveTask();
    } else this.deleteError = r.text || "failed";
    this.draw(true);
  }

  // ---- New project

  private drawForm(c: HqConfig): void {
    const d = this.draft;
    const top = el("div", "pp-top", "", this.root);
    this.back(top);
    el("div", "ac-title pp-form-title", "New project", this.root);

    const input = <K extends "input" | "textarea">(label: string, tag: K, cls: string, get: () => string, set: (v: string) => void) => {
      el("div", "ac-sec", label, this.root);
      const box = el(tag, cls, "", this.root);
      box.dataset.keep = cls;
      box.value = get();
      box.addEventListener("input", () => {
        set(box.value);
        warn();
      });
      return box;
    };
    input("Name", "input", "pp-name-input", () => d.name, (v) => (d.name = v)).placeholder = "e.g. snake";
    input("Folder", "input", "pp-folder-input", () => d.folder, (v) => (d.folder = v)).placeholder = "Empty for a sandbox";
    const goal = input("First goal", "textarea", "pp-first-goal", () => d.goal, (v) => (d.goal = v));
    goal.rows = 2;
    goal.maxLength = 2000;

    el("div", "ac-sec", "Agents", this.root);
    const list = el("div", "pp-agents", "", this.root);
    const boxes: Array<[string, HTMLInputElement]> = [];
    for (const a of c.agents) {
      const label = el("label", "ac-check pp-agent", "", list);
      const box = el("input", "", "", label);
      box.type = "checkbox";
      box.checked = d.agents === null || d.agents.has(a.id);
      label.append(` ${a.name} (${a.role})`);
      box.addEventListener("change", () => {
        d.agents = new Set(boxes.filter(([, b]) => b.checked).map(([id]) => id));
        warn();
      });
      boxes.push([a.id, box]);
    }
    if (c.agents.length === 0) el("span", "ac-empty", "No agents yet. Add one in Configure.", list);

    const warnBox = el("div", "pp-warn", "", this.root);
    const warn = () => {
      const chosen = c.agents.filter((a) => d.agents === null || d.agents.has(a.id));
      const text = `${d.name} ${d.goal}`.toLowerCase();
      const have = new Set(chosen.flatMap((a) => a.skills));
      const skills = c.skills.filter((s) => mentions(text, s.name) && !have.has(s.name)).map((s) => s.name);
      // A new project has no MCP server yet: one the goal names must be given in Configure.
      const mcp = c.mcpServers.filter((s) => mentions(text, s.name)).map((s) => s.name);
      const parts: string[] = [];
      if (skills.length > 0) parts.push(`No chosen agent has the skill ${skills.join(", ")}.`);
      if (mcp.length > 0) parts.push(`The MCP server ${mcp.join(", ")} is not given to this project.`);
      warnBox.hidden = parts.length === 0;
      warnBox.textContent = parts.length === 0 ? "" : `${parts.join(" ")} Add them in Configure, or create anyway.`;
    };
    warn();

    this.statusEl = el("pre", "pp-status", "", this.root);
    const buttons = el("div", "pp-buttons", "", this.root);
    this.createBtn = this.button(buttons, "Create", () => void this.create(c), "approve");
    this.paintForm();
    this.button(buttons, "Cancel", () => this.go(null));
  }

  /** Shows the draft's status and busy state on the form now on screen. */
  private paintForm(): void {
    const d = this.draft;
    if (this.statusEl) {
      this.statusEl.textContent = d.status.text;
      this.statusEl.className = d.status.bad ? "pp-status bad" : "pp-status";
    }
    if (this.createBtn) this.createBtn.disabled = d.busy;
  }

  /** Runs init (with --path for a folder), grants each chosen agent, then submits the first goal. Stops at the first failure. */
  private async create(c: HqConfig): Promise<void> {
    const d = this.draft;
    if (d.busy) return;
    const say = (text: string, bad: boolean) => {
      d.status = { text, bad };
      this.paintForm();
    };
    const name = d.name.trim().toLowerCase();
    if (!NAME_RE.test(name)) return say("Name: use a-z, 0-9 and -, up to 32 characters.", true);
    if (c.projects.some((p) => p.id === name) && !d.done.has(`init ${name}`)) return say(`A project named ${name} already exists.`, true);
    const folder = d.folder.trim();
    const chosen = c.agents.filter((a) => d.agents === null || d.agents.has(a.id)).map((a) => a.id);
    const steps = [
      { key: `init ${name}`, argv: ["init", name, ...(folder ? ["--path", folder] : [])] },
      ...chosen.map((id) => ({ key: `grant ${name} ${id}`, argv: ["grant", name, id] })),
    ];
    d.busy = true;
    say("working…", false);
    const lines: string[] = [];
    for (const step of steps) {
      if (d.done.has(step.key)) continue;
      let r: { code: number; text: string };
      try {
        r = await this.hooks.run(step.argv);
      } catch (e) {
        r = { code: 1, text: e instanceof Error ? e.message : String(e) };
      }
      if (r.text) lines.push(r.text);
      if (r.code !== 0) {
        d.busy = false;
        return say(lines.join("\n") || "failed", true);
      }
      d.done.add(step.key);
    }
    d.busy = false;
    const goal = d.goal.trim();
    if (goal && !this.send({ type: "goal.submit", projectId: name, text: goal })) {
      return say(`${lines.join("\n")}\nOffline: the project exists, the goal was not sent.`.trim(), true);
    }
    this.draft = newDraft();
    this.note = `Created ${name}.`;
    this.go(null);
  }
}
