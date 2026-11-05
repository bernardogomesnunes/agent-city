import type Database from "better-sqlite3";
import { redact } from "./redact.js";

export interface ApprovalRequest {
  projectId: string;
  agentId: string;
  tool: string;
  args: unknown;
  tier: number;
  estimatedUsd: number;
}
export type ApprovalStatus = "approved" | "denied";
export interface Approver {
  decide(req: ApprovalRequest & { id: number }): Promise<ApprovalStatus>;
}

interface Row {
  id: number;
  project_id: string;
  agent_id: string;
  tool: string;
  args_json: string;
  tier: number;
  estimated_usd: number;
}

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const toRequest = (r: Row): ApprovalRequest & { id: number } => ({
  id: r.id,
  projectId: r.project_id,
  agentId: r.agent_id,
  tool: r.tool,
  args: JSON.parse(r.args_json) as unknown,
  tier: r.tier,
  estimatedUsd: r.estimated_usd,
});

/** Whether a process with this id runs. Signal 0 checks without touching it; EPERM means it runs as another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ApprovalQueue {
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: string[] = [],
    private readonly now: () => Date = () => new Date(),
    /** The process that waits for this queue's requests. A row whose process ended can never be answered. */
    private readonly owner: number = process.pid,
  ) {}

  private insert(req: ApprovalRequest, status: "pending" | "approved", decidedBy: string | null): number {
    const ts = this.now().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO approvals (ts, project_id, agent_id, tool, args_json, tier, estimated_usd, status, decided_at, decided_by, owner_pid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        req.projectId,
        req.agentId,
        req.tool,
        JSON.stringify(redact(req.args ?? null, this.secrets)),
        req.tier,
        req.estimatedUsd,
        status,
        status === "pending" ? null : ts,
        decidedBy,
        this.owner,
      );
    return Number(info.lastInsertRowid);
  }

  async request(req: ApprovalRequest, approver: Approver): Promise<ApprovalStatus> {
    const id = this.insert(req, "pending", null);
    let status: ApprovalStatus;
    let decidedBy = "user";
    try {
      status = await approver.decide({ ...req, args: redact(req.args ?? null, this.secrets), id });
    } catch {
      status = "denied";
      decidedBy = "error";
    }
    // Only a still-pending row is updated, so a shutdown denial is never overwritten.
    const changed = this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
      .run(status, this.now().toISOString(), decidedBy, id).changes;
    if (changed === 0) {
      const cur = this.db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: ApprovalStatus };
      return cur.status;
    }
    return status;
  }

  recordAuto(req: ApprovalRequest): void {
    this.insert(req, "approved", "auto");
  }

  autoTotalToday(projectId: string): number {
    const today = localDate(this.now());
    const rows = this.db
      .prepare("SELECT ts, estimated_usd FROM approvals WHERE project_id = ? AND decided_by = 'auto'")
      .all(projectId) as Array<{ ts: string; estimated_usd: number }>;
    let total = 0;
    for (const r of rows) if (localDate(new Date(r.ts)) === today) total += r.estimated_usd;
    return total;
  }

  /**
   * Denies pending rows nobody can answer: their process ended (a restarted city, a closed terminal),
   * or they predate owner tracking. Returns how many.
   */
  expireOrphans(alive: (pid: number) => boolean = pidAlive): number {
    const rows = this.db.prepare("SELECT id, owner_pid FROM approvals WHERE status = 'pending'").all() as Array<{ id: number; owner_pid: number | null }>;
    const stale = rows.filter((r) => r.owner_pid === null || !alive(r.owner_pid));
    const done = this.db.prepare("UPDATE approvals SET status = 'denied', decided_at = ?, decided_by = 'expired' WHERE id = ? AND status = 'pending'");
    for (const r of stale) done.run(this.now().toISOString(), r.id);
    return stale.length;
  }

  denyAllPending(decidedBy = "shutdown"): number {
    return this.db
      .prepare("UPDATE approvals SET status = 'denied', decided_at = ?, decided_by = ? WHERE status = 'pending'")
      .run(this.now().toISOString(), decidedBy).changes;
  }

  pendingAll(): Array<ApprovalRequest & { id: number }> {
    const rows = this.db
      .prepare("SELECT id, project_id, agent_id, tool, args_json, tier, estimated_usd FROM approvals WHERE status = 'pending' ORDER BY id")
      .all() as Row[];
    return rows.map(toRequest);
  }

  pending(projectId: string): Array<ApprovalRequest & { id: number }> {
    const rows = this.db
      .prepare("SELECT id, project_id, agent_id, tool, args_json, tier, estimated_usd FROM approvals WHERE project_id = ? AND status = 'pending' ORDER BY id")
      .all(projectId) as Row[];
    return rows.map(toRequest);
  }
}
