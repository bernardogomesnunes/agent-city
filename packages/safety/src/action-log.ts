import type Database from "better-sqlite3";
import type { AgentEvent, EventSink } from "@agentcity/core";
import { redact } from "./redact.js";

export interface ActionRow { id: number; ts: string; projectId: string; agentId: string; type: string; payload: unknown; usd: number; runId: string | null; parentRunId: string | null }

interface RawRow { id: number; ts: string; project_id: string; agent_id: string; type: string; payload_json: string; usd: number; run_id: string | null; parent_run_id: string | null }

const toRow = (r: RawRow): ActionRow => ({
  id: r.id, ts: r.ts, projectId: r.project_id, agentId: r.agent_id, type: r.type,
  payload: JSON.parse(r.payload_json), usd: r.usd, runId: r.run_id, parentRunId: r.parent_run_id,
});

export class ActionLog {
  constructor(private db: Database.Database, private secrets: string[]) {}

  append(e: { projectId: string; agentId: string; type: string; payload: unknown; usd?: number; ts?: string; runId?: string; parentRunId?: string }): number {
    const payload = redact(e.payload ?? null, this.secrets);
    const info = this.db
      .prepare("INSERT INTO actions (ts, project_id, agent_id, type, payload_json, usd, run_id, parent_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.ts ?? new Date().toISOString(), e.projectId, e.agentId, e.type, JSON.stringify(payload), e.usd ?? 0, e.runId ?? null, e.parentRunId ?? null);
    return Number(info.lastInsertRowid);
  }

  list(projectId: string, afterId = 0): ActionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM actions WHERE project_id = ? AND id > ? ORDER BY id")
      .all(projectId, afterId) as RawRow[];
    return rows.map(toRow);
  }

  /** Rows of all projects with id > afterId, ascending. */
  rowsAfter(afterId: number, limit = -1): ActionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM actions WHERE id > ? ORDER BY id LIMIT ?")
      .all(afterId, limit) as RawRow[];
    return rows.map(toRow);
  }

  /** Rows of the listed runs with id > afterId, ascending. */
  ofRuns(runIds: string[], afterId = 0): ActionRow[] {
    if (runIds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM actions WHERE id > ? AND run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY id`)
      .all(afterId, ...runIds) as RawRow[];
    return rows.map(toRow);
  }

  /** The last n rows of all projects, ascending by id. */
  lastRows(n: number): ActionRow[] {
    const rows = this.db.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").all(n) as RawRow[];
    return rows.reverse().map(toRow);
  }

  sink(): EventSink {
    return {
      emit: (e: AgentEvent) => {
        const { ts, projectId, agentId, type, runId, parentRunId, ...payload } = e;
        this.append({ ts, projectId, agentId, type, payload, runId, parentRunId });
      },
    };
  }
}
