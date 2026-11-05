import { ActionLog, ApprovalQueue, CityPlots, type openDb } from "@agentcity/safety";
import { PLOT_KINDS, type AgentView, type ApprovalView, type CityState, type PlotKind, type PlotView, type RunView } from "./shared/index.js";
import { CityModel, type AgentInfo, type WorldCtx } from "./state.js";

type Db = ReturnType<typeof openDb>;

export const FIRST_POLL_ROWS = 500;
const PREVIEW_MAX = 120;
const PLOT_COUNT = 6;

export interface FeedDeps {
  listAgents(): AgentInfo[];
  localApprovalIds(): ReadonlySet<number>;
  redactText(s: string): string;
  now?(): number;
}
export interface FeedChange { agents: AgentView[]; plots: PlotView[]; approvals?: ApprovalView[]; runs?: RunView[] }

export class CityFeed {
  private readonly log: ActionLog;
  private readonly plotStore: CityPlots;
  private readonly queue: ApprovalQueue;
  private readonly model = new CityModel();
  private lastId = 0;
  private first = true;
  private prevAgents = new Map<string, string>();
  private prevPlots = new Map<string, string>();
  private prevApprovals: string | undefined;
  private prevRuns: string | undefined;

  constructor(db: Db, private readonly deps: FeedDeps) {
    this.log = new ActionLog(db, []);
    this.plotStore = new CityPlots(db);
    this.queue = new ApprovalQueue(db);
  }

  /** All six plots; unbuilt ones carry only the id. */
  private plots(): PlotView[] {
    const built = new Map(this.plotStore.list().map((p) => [p.plot, p]));
    const out: PlotView[] = [];
    for (let n = 1; n <= PLOT_COUNT; n++) {
      const p = built.get(n);
      const view: PlotView = { id: `plot-${n}` };
      if (p && (PLOT_KINDS as readonly string[]).includes(p.kind)) view.kind = p.kind as PlotKind;
      if (p) view.builtBy = p.agentId;
      out.push(view);
    }
    return out;
  }

  poll(): { state: CityState; changed: FeedChange } {
    const now = this.deps.now?.() ?? Date.now();
    const ctx: WorldCtx = { agents: this.deps.listAgents(), plots: this.plots(), now, redactText: this.deps.redactText };
    const rows = this.first ? this.log.lastRows(FIRST_POLL_ROWS) : this.log.rowsAfter(this.lastId);

    const local = this.deps.localApprovalIds();
    // A run that died (city restart, closed terminal) leaves rows nobody can answer; close them.
    this.queue.expireOrphans();
    const approvals: ApprovalView[] = this.queue.pendingAll().map((r) => ({
      id: r.id,
      projectId: r.projectId,
      agentId: r.agentId,
      tool: r.tool,
      argsPreview: this.deps.redactText(JSON.stringify(r.args ?? null)).slice(0, PREVIEW_MAX),
      tier: r.tier,
      estimatedUsd: r.estimatedUsd,
      local: local.has(r.id),
    }));

    this.model.sync(ctx);
    this.model.applyRows(rows, ctx);
    if (this.first) this.model.settleHistory();
    this.model.setApprovals(approvals, ctx);
    this.model.tick(now);
    // The cursor moves only after the whole poll worked, so a throw above re-reads these rows.
    this.first = false;
    if (rows.length > 0) this.lastId = rows[rows.length - 1]!.id;
    const state = this.model.state();

    const changed: FeedChange = {
      agents: this.diff(state.agents, this.prevAgents),
      plots: this.diff(state.plots, this.prevPlots),
    };
    const approvalsJson = JSON.stringify(state.approvals);
    if (approvalsJson !== this.prevApprovals) changed.approvals = state.approvals;
    this.prevApprovals = approvalsJson;
    const runsJson = JSON.stringify(state.runs);
    if (runsJson !== this.prevRuns) changed.runs = state.runs;
    this.prevRuns = runsJson;
    return { state, changed };
  }

  private diff<T extends { id: string }>(items: T[], prev: Map<string, string>): T[] {
    const out: T[] = [];
    const next = new Map<string, string>();
    for (const it of items) {
      const j = JSON.stringify(it);
      next.set(it.id, j);
      if (prev.get(it.id) !== j) out.push(it);
    }
    prev.clear();
    for (const [k, v] of next) prev.set(k, v);
    return out;
  }
}

export class Ticker {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly fn: () => void, private readonly ms = 250) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(this.fn, this.ms);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
