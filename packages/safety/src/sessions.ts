import type Database from "better-sqlite3";
import { redact } from "./redact.js";

export type SessionKind = "user" | "agent" | "report" | "system";
export type SessionStatus = "queued" | "running" | "done";

export interface Session {
  id: number;
  projectId: string;
  agentId: string;
  createdAt: string;
  branch: string | null;
  /** The first player message cut to 40 characters. Empty until the player writes. */
  title: string;
  /** The task this chat is about, when it was opened from one. */
  taskId?: string;
  /** The goal this chat is about, when it was opened from one. */
  goalId?: string;
}

export interface SessionMessage {
  id: number;
  sessionId: number;
  ts: string;
  kind: SessionKind;
  author: string;
  text: string;
  status: SessionStatus;
  runId: string | null;
}

/** The longest chat title. */
export const SESSION_TITLE_MAX = 40;

/** The longest text a message keeps, the same as the goal limit. */
export const SESSION_TEXT_MAX = 4000;

interface SessionRow { id: number; project_id: string; agent_id: string; created_at: string; branch: string | null; title: string; task_id: string | null; goal_id: string | null }
interface MessageRow { id: number; session_id: number; ts: string; kind: SessionKind; author: string; text: string; status: SessionStatus; run_id: string | null }

const toSession = (r: SessionRow): Session => ({ id: r.id, projectId: r.project_id, agentId: r.agent_id, createdAt: r.created_at, branch: r.branch, title: r.title,
  ...(r.task_id ? { taskId: r.task_id } : {}), ...(r.goal_id ? { goalId: r.goal_id } : {}),
});
const toMessage = (r: MessageRow): SessionMessage => ({
  id: r.id, sessionId: r.session_id, ts: r.ts, kind: r.kind, author: r.author, text: r.text, status: r.status, runId: r.run_id,
});

/**
 * Chats with agents and their messages. A chat has an agent and an optional project (empty when none).
 * Every text is redacted with the stored secrets before it is written.
 */
export class SessionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: string[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A new chat. `projectId` is empty for a chat without a project. `opts` names the chat and ties it to a task or goal. */
  create(projectId: string, agentId: string, opts: { title?: string; taskId?: string; goalId?: string } = {}): Session {
    const info = this.db
      .prepare("INSERT INTO sessions (project_id, agent_id, created_at, title, task_id, goal_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, agentId, this.now().toISOString(), redact(opts.title ?? "", this.secrets).slice(0, SESSION_TITLE_MAX), opts.taskId ?? null, opts.goalId ?? null);
    return this.get(Number(info.lastInsertRowid))!;
  }

  /** The newest chat of this pair, created when there is none. */
  open(projectId: string, agentId: string): Session {
    const r = this.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1").get(projectId, agentId) as SessionRow | undefined;
    return r ? toSession(r) : this.create(projectId, agentId);
  }

  /** Every chat of the agent, oldest first. */
  forAgent(agentId: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE agent_id = ? ORDER BY id").all(agentId) as SessionRow[]).map(toSession);
  }

  get(id: number): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return r && toSession(r);
  }

  list(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY id").all() as SessionRow[]).map(toSession);
  }

  setBranch(id: number, branch: string | null): void {
    this.db.prepare("UPDATE sessions SET branch = ? WHERE id = ?").run(branch, id);
  }

  /** Clears the stored branch of every session that holds this one (after a merge). */
  clearBranch(projectId: string, branch: string): void {
    this.db.prepare("UPDATE sessions SET branch = NULL WHERE project_id = ? AND branch = ?").run(projectId, branch);
  }

  append(sessionId: number, m: { kind: SessionKind; author: string; text: string; status?: SessionStatus; runId?: string }): SessionMessage {
    const text = redact(m.text, this.secrets).slice(0, SESSION_TEXT_MAX);
    const info = this.db
      .prepare("INSERT INTO session_messages (session_id, ts, kind, author, text, status, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, this.now().toISOString(), m.kind, m.author, text, m.status ?? "done", m.runId ?? null);
    // The first player message names the chat.
    if (m.kind === "user") this.db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = ''").run(text.slice(0, SESSION_TITLE_MAX), sessionId);
    return this.message(Number(info.lastInsertRowid))!;
  }

  message(id: number): SessionMessage | undefined {
    const r = this.db.prepare("SELECT * FROM session_messages WHERE id = ?").get(id) as MessageRow | undefined;
    return r && toMessage(r);
  }

  setStatus(id: number, status: SessionStatus, runId?: string): SessionMessage {
    this.db.prepare("UPDATE session_messages SET status = ?, run_id = COALESCE(?, run_id) WHERE id = ?").run(status, runId ?? null, id);
    return this.message(id)!;
  }

  /** The latest `limit` messages, oldest first. */
  messages(sessionId: number, limit = 200): SessionMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /** The id of the oldest player message of the chat. */
  firstUserId(sessionId: number): number | undefined {
    const r = this.db.prepare("SELECT MIN(id) AS id FROM session_messages WHERE session_id = ? AND kind = 'user'").get(sessionId) as { id: number | null };
    return r.id ?? undefined;
  }

  /** Whether a turn of the session runs, and how many player messages wait. */
  counts(sessionId: number): { running: boolean; queued: number } {
    const r = this.db
      .prepare("SELECT SUM(status = 'running') AS running, SUM(status = 'queued') AS queued FROM session_messages WHERE session_id = ? AND kind = 'user'")
      .get(sessionId) as { running: number | null; queued: number | null };
    return { running: (r.running ?? 0) > 0, queued: r.queued ?? 0 };
  }

  /** The oldest queued player message of any chat of the agent. */
  nextQueued(agentId: string): SessionMessage | undefined {
    const r = this.db
      .prepare(
        `SELECT m.* FROM session_messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.agent_id = ? AND m.kind = 'user' AND m.status = 'queued' ORDER BY m.id LIMIT 1`,
      )
      .get(agentId) as MessageRow | undefined;
    return r && toMessage(r);
  }

  /** Agents with at least one queued player message. */
  queuedAgents(): string[] {
    return (this.db
      .prepare("SELECT DISTINCT s.agent_id AS a FROM session_messages m JOIN sessions s ON s.id = m.session_id WHERE m.kind = 'user' AND m.status = 'queued'")
      .all() as Array<{ a: string }>).map((r) => r.a);
  }

  /** Player messages still marked running after a crash: done, each with a system line. Returns the lines. */
  recover(): SessionMessage[] {
    const stuck = this.db.prepare("SELECT * FROM session_messages WHERE status = 'running'").all() as MessageRow[];
    return stuck.map((r) => {
      this.setStatus(r.id, "done");
      return this.append(r.session_id, { kind: "system", author: "city", text: "stopped: city restarted" });
    });
  }
}
