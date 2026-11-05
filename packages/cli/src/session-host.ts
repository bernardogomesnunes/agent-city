import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AnyTool } from "@agentcity/core";
import { makeCreateGoalTool, type AgentStore, type PostGoal } from "@agentcity/org";
import { loadProjectConfig, SESSION_TEXT_MAX, type ActionRow, type BoardStore, type Session, type SessionMessage, type SessionStore } from "@agentcity/safety";
import type { SessionMessageView, SessionView } from "@agentcity/world/shared";
import type { Job, JobRunner } from "./job-runner.js";
import type { Scheduler } from "./scheduler.js";
import { taskContext, toLogRows } from "./task-log.js";
import { workDir } from "./workspace.js";

const LAST_CHARS = 80;
const HISTORY_ROWS = 200;

export interface SessionHostDeps {
  home: string;
  store: SessionStore;
  agents: AgentStore;
  /** Chat turns are jobs of kind `followup` with the chat tool set. */
  jobs: Pick<JobRunner, "run">;
  /** `runningTask` and `message` route a chat message to a working agent. `submitGoal` backs `create_goal`. */
  scheduler: Pick<Scheduler, "runningTask" | "message" | "submitGoal" | "agentRunning" | "tick">;
  /** The board, for chats about a task or goal. */
  board: Pick<BoardStore, "task" | "goal" | "tasks" | "runs">;
  /** The action rows of one run, for the log a task chat starts with. */
  runRows(runId: string): ActionRow[];
  /** Hides stored secrets in text the chat shows the agent. */
  redactText(s: string): string;
  /** Whether an old agent tree holds the project. Only used to refuse removing a busy agent. */
  projectBusy?(projectId: string): boolean;
  /** A new or changed message, for every open tab. */
  onMessage(m: SessionMessageView): void;
  /** The session list changed. */
  onList(): void;
  log?: (line: string) => void;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

interface Turn {
  sessionId: number;
  controller: AbortController;
}

const view = (m: SessionMessage): SessionMessageView => ({
  id: m.id, sessionId: m.sessionId, ts: m.ts, kind: m.kind, author: m.author, text: m.text, status: m.status,
});

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Plain chats with agents. A message waits as queued. Each agent runs the oldest queued message of any of its
 * chats, one turn at a time. A turn is one job of the agent with the chat tool set and never takes a project's work slot.
 * A message to an agent that works on a task goes to that task's inbox instead.
 */
export class SessionHost {
  private readonly turns = new Map<string, Turn>();
  private readonly chains = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly d: SessionHostDeps) {}

  /** Closes turns a crash left running and starts what waits. Call once at startup. */
  start(): void {
    this.stopped = false;
    for (const m of this.d.store.recover()) this.d.onMessage(view(m));
    for (const a of this.d.store.queuedAgents()) this.pump(a);
  }

  /** Aborts every running turn. Queued messages stay queued for the next start. */
  stop(): void {
    this.stopped = true;
    for (const t of this.turns.values()) t.controller.abort();
  }

  /** Resolves when no turn is being finished. */
  async whenIdle(): Promise<void> {
    while (this.chains.size > 0) await Promise.allSettled([...this.chains]);
  }

  /**
   * A new chat. `projectId` is empty or missing for a chat without a project.
   * A `ref` ties the chat to a task or goal: it takes the title and the project from the board.
   * When the agent is gone, a chat about a goal opens with the goal's Manager and says so.
   */
  create(agentId: string, projectId?: string, ref: { taskId?: string; goalId?: string } = {}): Result<{ sessionId: number }> {
    const task = ref.taskId ? this.d.board.task(ref.taskId) : undefined;
    if (ref.taskId && !task) return { ok: false, error: `No task ${ref.taskId}` };
    const goal = ref.goalId ? this.d.board.goal(ref.goalId) : task ? this.d.board.goal(task.goalId) : undefined;
    if (ref.goalId && !goal) return { ok: false, error: `No goal ${ref.goalId}` };
    // A chat about a task or goal belongs to that task's or goal's project, whatever the client sent.
    const project = (ref.taskId ? task?.projectId : ref.goalId ? goal?.projectId : projectId) || undefined;
    let agent = agentId;
    let removed: string | undefined;
    if (!this.d.agents.get(agentId) && goal) {
      const manager = this.managerOf(goal.id, goal.projectId);
      if (manager) {
        agent = manager;
        removed = `${agentId} was removed. This chat is with the Manager ${this.name(manager)}.`;
      }
    }
    const bad = this.checkAgent(agent) ?? (project ? this.checkProject(project) : undefined);
    if (bad) return { ok: false, error: bad };
    const title = task?.title ?? (ref.goalId ? goal!.text : undefined);
    const s = this.d.store.create(project ?? "", agent, {
      ...(title !== undefined ? { title } : {}), ...(ref.taskId ? { taskId: ref.taskId } : {}), ...(ref.goalId ? { goalId: ref.goalId } : {}),
    });
    if (removed) this.post(this.d.store.append(s.id, { kind: "system", author: "city", text: removed }));
    this.d.onList();
    return { ok: true, sessionId: s.id };
  }

  /** The thread of one chat. */
  open(sessionId: number): Result<{ sessionId: number; messages: SessionMessageView[] }> {
    const s = this.d.store.get(sessionId);
    if (!s) return { ok: false, error: `No chat ${sessionId}` };
    return { ok: true, sessionId: s.id, messages: this.d.store.messages(s.id, HISTORY_ROWS).map(view) };
  }

  /** The older pair form: the newest chat of the pair, created when there is none. */
  openPair(projectId: string, agentId: string): Result<{ sessionId: number; messages: SessionMessageView[] }> {
    const bad = this.checkAgent(agentId) ?? this.checkProject(projectId);
    if (bad) return { ok: false, error: bad };
    const s = this.d.store.open(projectId, agentId);
    this.d.onList();
    return { ok: true, sessionId: s.id, messages: this.d.store.messages(s.id, HISTORY_ROWS).map(view) };
  }

  send(sessionId: number, text: string): Result {
    const s = this.d.store.get(sessionId);
    if (!s) return { ok: false, error: `No chat ${sessionId}` };
    return this.sendTo(s, text);
  }

  sendPair(projectId: string, agentId: string, text: string): Result {
    const bad = this.checkAgent(agentId) ?? this.checkProject(projectId);
    if (bad) return { ok: false, error: bad };
    return this.sendTo(this.d.store.open(projectId, agentId), text);
  }

  list(): SessionView[] {
    // A removed agent's chats stay in the database as history, out of the list.
    return this.d.store.list().filter((s) => this.d.agents.get(s.agentId)).map((s) => {
      const c = this.d.store.counts(s.id);
      const last = this.d.store.messages(s.id, 1)[0];
      const status = c.running ? (c.queued > 0 ? "queued" : "working") : c.queued > 0 ? (this.turns.has(s.agentId) ? "waiting" : "queued") : "idle";
      const text = last ? `${last.author === "you" ? "you" : this.name(last.author)}: ${last.text.replace(/\s+/g, " ")}` : "";
      return {
        id: s.id, ...(s.projectId === "" ? {} : { projectId: s.projectId }), agentId: s.agentId, title: s.title, status, queued: c.queued,
        last: text.length > LAST_CHARS ? `${text.slice(0, LAST_CHARS - 1)}…` : text, lastTs: last?.ts ?? s.createdAt,
        taskId: s.taskId ?? null, goalId: s.goalId ?? null,
      };
    });
  }

  /** Whether a chat turn of the agent runs or waits, its board job runs, or a project the agent works on is held by an old tree run. */
  agentBusy(agentId: string, projects: string[]): boolean {
    if (this.turns.has(agentId) || this.d.store.nextQueued(agentId) || this.d.scheduler.runningTask(agentId) !== undefined) return true;
    return projects.some((p) => this.d.projectBusy?.(p) ?? false);
  }

  /** Whether a chat turn of a session in the project runs. */
  projectChatting(projectId: string): boolean {
    return [...this.turns.values()].some((t) => this.d.store.get(t.sessionId)?.projectId === projectId);
  }

  /** Aborts the running chat turns of the sessions in the project. */
  abortProject(projectId: string): void {
    for (const t of this.turns.values()) if (this.d.store.get(t.sessionId)?.projectId === projectId) t.controller.abort();
  }

  /** Whether a chat turn of the agent runs or waits. The scheduler holds the agent's board jobs until then. */
  chatting(agentId: string): boolean {
    return this.turns.has(agentId) || this.d.store.nextQueued(agentId) !== undefined;
  }

  /** Starts the agent's oldest queued message when no turn and no board job of the agent runs. Safe to call any time. */
  pump(agentId: string): void {
    if (this.stopped || this.turns.has(agentId) || this.d.scheduler.agentRunning(agentId)) return this.d.onList();
    const next = this.d.store.nextQueued(agentId);
    if (!next) return this.d.onList();
    const session = this.d.store.get(next.sessionId)!;
    const history = this.d.store
      .messages(session.id, HISTORY_ROWS)
      // A queued message can be older than the answers before its turn, so filter by status, not by id.
      .filter((m) => m.id !== next.id && m.status === "done" && (m.kind === "user" || m.kind === "agent"))
      .map((m) => ({ role: m.kind === "user" ? ("user" as const) : ("assistant" as const), content: m.text }));
    const turn: Turn = { sessionId: session.id, controller: new AbortController() };
    this.turns.set(agentId, turn);
    this.post(this.d.store.setStatus(next.id, "running"));
    this.d.onList();
    const chain: Promise<void> = this.runTurn(session, next, history, turn)
      .catch((e: unknown) => this.d.log?.(`chat: ${session.id}: ${errorText(e)}`))
      .finally(() => {
        this.chains.delete(chain);
        this.turns.delete(agentId);
        this.pump(agentId);
        // Board jobs held for this turn can start now.
        if (!this.turns.has(agentId)) void this.d.scheduler.tick();
      });
    this.chains.add(chain);
  }

  // ---------------------------------------------------------------- private

  private sendTo(s: Session, text: string): Result {
    const t = text.trim();
    if (t.length < 1 || t.length > SESSION_TEXT_MAX) return { ok: false, error: `message must be 1 to ${SESSION_TEXT_MAX} characters` };
    const bad = this.checkAgent(s.agentId);
    if (bad) return { ok: false, error: bad };
    const gone = s.taskId && !this.d.board.task(s.taskId) ? "the task is gone" : s.goalId && !this.d.board.goal(s.goalId) ? "the goal is gone" : undefined;
    if (gone) {
      // The board no longer has what the chat is about (its project was removed). The message is kept, no turn runs.
      this.post(this.d.store.append(s.id, { kind: "user", author: "you", text: t }));
      this.post(this.d.store.append(s.id, { kind: "system", author: "city", text: gone }));
      this.d.onList();
      return { ok: true };
    }
    const taskId = this.d.scheduler.runningTask(s.agentId);
    if (taskId !== undefined) {
      // The agent works on a task right now: the message joins that job's inbox.
      this.post(this.d.store.append(s.id, { kind: "user", author: "you", text: t }));
      this.d.scheduler.message(taskId, t);
      this.post(this.d.store.append(s.id, { kind: "system", author: "city", text: `sent to ${this.name(s.agentId)} on ${taskId}` }));
      this.d.onList();
      return { ok: true };
    }
    this.post(this.d.store.append(s.id, { kind: "user", author: "you", text: t, status: "queued" }));
    this.d.onList();
    this.pump(s.agentId);
    return { ok: true };
  }

  private async runTurn(session: Session, next: SessionMessage, history: Job["history"], turn: Turn): Promise<void> {
    const line = (text: string) => this.post(this.d.store.append(session.id, { kind: "system", author: "city", text }));
    let cwd: string;
    try {
      cwd = this.cwdOf(session);
    } catch (e) {
      this.post(this.d.store.setStatus(next.id, "done"));
      line(`could not start: ${errorText(e)}`);
      return;
    }
    const runId = randomBytes(6).toString("hex");
    const job: Job = {
      kind: "followup", projectId: session.projectId, goalId: "", agentId: session.agentId, prompt: this.firstTurn(session, next) ? this.withContext(session, next.text) : next.text, cwd, runId, tools: "chat",
      ...(history && history.length > 0 ? { history } : {}),
    };
    try {
      const res = await this.d.jobs.run(job, this.chatTools(session.agentId), turn.controller.signal, () => []);
      this.post(this.d.store.setStatus(next.id, "done", res.runId));
      if (res.answer.trim()) this.post(this.d.store.append(session.id, { kind: "agent", author: session.agentId, text: res.answer, runId: res.runId }));
      if (res.reason !== "done") line(`stopped: ${res.reason}, ${res.steps} steps${res.detail ? `: ${res.detail}` : ""}`);
      else if (!res.answer.trim()) line("finished with no answer");
    } catch (e) {
      this.post(this.d.store.setStatus(next.id, "done"));
      line(`stopped: ${errorText(e)}`);
    }
  }

  /** Whether `next` is the first player message of a chat about a task or goal. */
  private firstTurn(session: Session, next: SessionMessage): boolean {
    if (!session.taskId && !session.goalId) return false;
    return this.d.store.firstUserId(session.id) === next.id;
  }

  /** The task or goal text a chat about one starts with, then the player's message. */
  private withContext(session: Session, text: string): string {
    const task = session.taskId ? this.d.board.task(session.taskId) : undefined;
    if (task) {
      const rows = this.d.board.runs(task.id).flatMap((r) => this.d.runRows(r.runId));
      return `${taskContext(task, toLogRows(rows, this.d.redactText), this.d.redactText)}\n\n${text}`;
    }
    const goal = session.goalId ? this.d.board.goal(session.goalId) : undefined;
    if (!goal) return text;
    const tasks = this.d.board.tasks(goal.id).map((x) => `- ${x.id} ${this.d.redactText(x.title)} (${x.status})`);
    const head = `This chat is about goal ${goal.id}: ${this.d.redactText(goal.text)}`;
    return `${[head, ...(tasks.length > 0 ? ["Tasks:", ...tasks] : [])].join("\n")}\n\n${text}`;
  }

  /** The Manager of a goal: the author of its first task that a manager made, else the project's first manager, else its first agent. */
  private managerOf(goalId: string, projectId: string): string | undefined {
    const role = (id: string) => this.d.agents.get(id)?.role;
    const author = this.d.board.tasks(goalId).find((t) => role(t.createdBy) === "manager");
    if (author) return author.createdBy;
    let team: string[] = [];
    try {
      const loaded = loadProjectConfig(this.d.home, projectId);
      if (loaded.ok) team = loaded.config.agents.filter((id) => this.d.agents.get(id));
    } catch {
      team = [];
    }
    return team.find((id) => role(id) === "manager") ?? team[0];
  }

  /** `create_goal` for the boss and managers. It posts through the scheduler. */
  private chatTools(agentId: string): AnyTool[] {
    const role = this.d.agents.get(agentId)?.role;
    if (role !== "boss" && role !== "manager") return [];
    const post: PostGoal = (project, text) => {
      const bad = this.checkProject(project);
      if (bad) return { ok: false, error: bad };
      try {
        return { ok: true, goalId: this.d.scheduler.submitGoal(project, text).id };
      } catch (e) {
        return { ok: false, error: errorText(e) };
      }
    };
    return [makeCreateGoalTool(post) as AnyTool];
  }

  /** The project root for a chat with a project, else a scratch folder under the home. */
  private cwdOf(s: Session): string {
    if (s.projectId !== "") {
      const loaded = loadProjectConfig(this.d.home, s.projectId);
      if (!loaded.ok) throw new Error(`No project ${s.projectId}`);
      return workDir(this.d.home, loaded.config, s.projectId);
    }
    const dir = path.join(this.d.home, "chats", String(s.id));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private post(m: SessionMessage): void {
    this.d.onMessage(view(m));
  }

  private name(agentId: string): string {
    return this.d.agents.get(agentId)?.name ?? agentId;
  }

  private checkAgent(agentId: string): string | undefined {
    return this.d.agents.get(agentId) ? undefined : `No agent ${agentId}`;
  }

  private checkProject(projectId: string): string | undefined {
    let ok = false;
    try {
      ok = loadProjectConfig(this.d.home, projectId).ok;
    } catch {
      ok = false;
    }
    return ok ? undefined : `No project ${projectId}`;
  }
}
