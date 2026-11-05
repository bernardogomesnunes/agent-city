export interface TreeLimits {
  maxDepth: number;
  maxTreeUsd: number;
  maxChildRuns: number;
}

/** Limits shared by every run in one delegation tree. */
export class RunTree {
  private spent = 0;
  private used = 0;
  private children = 0;

  constructor(private readonly limits: TreeLimits) {}

  addUsd(usd: number): void {
    this.spent += usd;
  }

  addTokens(n: number): void {
    this.used += n;
  }

  get usd(): number {
    return this.spent;
  }

  /** Tokens used by every run in this tree. The gate's job cap reads it. */
  get tokens(): number {
    return this.used;
  }

  get childRuns(): number {
    return this.children;
  }

  reserveChild(depth: number): { ok: true } | { ok: false; reason: "depth_limit" | "child_run_limit" } {
    if (depth > this.limits.maxDepth) return { ok: false, reason: "depth_limit" };
    if (this.children >= this.limits.maxChildRuns) return { ok: false, reason: "child_run_limit" };
    this.children++;
    return { ok: true };
  }
}
