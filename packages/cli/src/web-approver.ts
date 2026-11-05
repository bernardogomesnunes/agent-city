import type { ApprovalRequest, ApprovalStatus } from "@agentcity/safety";
import type { ClosableApprover } from "./approver.js";

interface Pending {
  owner: WebApprover;
  resolve: (s: ApprovalStatus) => void;
}

/** Holds approvals that the city UI answers. One pending promise per approval id, no timeout. */
export class WebApprovals {
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: Array<() => void> = [];

  /** Ids of approvals the web UI can answer. */
  waiting(): ReadonlySet<number> {
    return new Set(this.pending.keys());
  }

  factory = (): ClosableApprover => new WebApprover(this);

  /** Resolves one pending approval. False when the id is not held. */
  answer(id: number, decision: "approved" | "denied"): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.settle(id, p, decision);
    return true;
  }

  denyAll(): void {
    for (const [id, p] of [...this.pending]) this.settle(id, p, "denied");
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  /** @internal Used by WebApprover. */
  hold(id: number, owner: WebApprover): Promise<ApprovalStatus> {
    return new Promise<ApprovalStatus>((resolve) => {
      this.pending.set(id, { owner, resolve });
      this.changed();
    });
  }

  /** @internal Used by WebApprover. Denies the pending approvals of one approver. */
  denyOwned(owner: WebApprover): void {
    for (const [id, p] of [...this.pending]) if (p.owner === owner) this.settle(id, p, "denied");
  }

  private settle(id: number, p: Pending, decision: ApprovalStatus): void {
    this.pending.delete(id);
    p.resolve(decision);
    this.changed();
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }
}

class WebApprover implements ClosableApprover {
  private cancelled = false;
  constructor(private readonly approvals: WebApprovals) {}

  decide(req: ApprovalRequest & { id: number }): Promise<ApprovalStatus> {
    if (this.cancelled) return Promise.resolve("denied");
    return this.approvals.hold(req.id, this);
  }

  cancel(): void {
    this.cancelled = true;
    this.approvals.denyOwned(this);
  }

  close(): void {
    this.cancel();
  }
}
