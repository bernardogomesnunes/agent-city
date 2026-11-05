import type { ActionRow } from "@agentcity/safety";
import type { AgentActivity, AgentView, ApprovalView, BuildingId, CityState, PlotView, RunView } from "./shared/index.js";

export interface AgentInfo { id: string; name: string; role: "boss" | "manager" | "worker"; building: "software" | "visual"; model?: string }
export interface WorldCtx { agents: AgentInfo[]; plots: PlotView[]; now: number; redactText: (s: string) => string }

export const STOPPED_MS = 5000;
const LAST_TEXT_MAX = 60;
const GOAL_MAX = 200;
/** A run with no new row for this long is dropped from the progress panel (its process probably died). */
export const RUN_STALE_MS = 15 * 60 * 1000;

export function homeOf(a: AgentInfo): BuildingId {
  if (a.role === "boss") return "director";
  if (a.role === "manager") return "hq";
  return a.building;
}

function builtPlot(plots: PlotView[], kind: string): BuildingId | undefined {
  const n = (p: PlotView): number => Number(p.id.slice(5));
  const hit = plots.filter((p) => p.kind === kind && p.builtBy !== undefined).sort((x, y) => n(x) - n(y))[0];
  return hit?.id as BuildingId | undefined;
}

/** Building for work-type activity: a matching built plot first, then the profile building. */
export function workOf(a: AgentInfo, activity: AgentActivity, plots: PlotView[]): BuildingId {
  if (activity === "reading") {
    const p = builtPlot(plots, "library");
    if (p) return p;
  }
  if (activity === "writing") {
    const p = builtPlot(plots, "workshop");
    if (p) return p;
  }
  if (a.building === "visual") {
    const p = builtPlot(plots, "studio");
    if (p) return p;
  }
  return a.building;
}

function buildingFor(a: AgentInfo, activity: AgentActivity, plots: PlotView[]): BuildingId {
  switch (activity) {
    case "messaging":
    case "delegating":
    case "building":
    case "waiting_approval":
      return "hq";
    case "remembering":
    case "idle":
    case "stopped":
      return homeOf(a);
    default:
      return workOf(a, activity, plots);
  }
}

const rests = (a: AgentActivity): boolean => a === "idle" || a === "stopped";

const TOOL_ACTIVITY: Record<string, AgentActivity> = {
  read_file: "reading",
  write_file: "writing",
  send_message: "messaging",
  delegate: "delegating",
  remember: "remembering",
  build: "building",
  list_files: "reading",
  search_files: "reading",
  edit_file: "writing",
  delete_file: "writing",
  run_command: "writing",
};

/** MCP tools reach outside the city, so their agents walk to HQ like messaging. */
const activityOf = (name: string): AgentActivity | undefined => TOOL_ACTIVITY[name] ?? (name.startsWith("mcp__") ? "messaging" : undefined);

function field(args: unknown, key: string): string | undefined {
  if (args && typeof args === "object") {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return undefined;
}

function mainArg(name: string, args: unknown): string | undefined {
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "delete_file":
    case "list_files": return field(args, "path");
    case "search_files": return field(args, "pattern");
    case "run_command": return field(args, "command");
    case "send_message": return field(args, "to");
    case "delegate": return field(args, "agent");
    case "build": {
      const plot = field(args, "plot");
      const kind = field(args, "kind");
      return plot === undefined ? kind : kind === undefined ? `plot-${plot}` : `plot-${plot} ${kind}`;
    }
    default: return undefined;
  }
}

interface Entry {
  info: AgentInfo;
  activity: AgentActivity;
  buildingId: BuildingId;
  projectId?: string;
  runId?: string;
  lastText?: string;
  stoppedAt?: number;
}

export class CityModel {
  private agents = new Map<string, Entry>();
  private plots: PlotView[] = [];
  private approvals: ApprovalView[] = [];
  private waiting = new Set<string>();
  private runs = new Map<string, RunView & { lastAt: number }>();
  /** Every run id, child or top, mapped to its top run id. */
  private topOf = new Map<string, string>();

  sync(ctx: WorldCtx): void {
    this.plots = ctx.plots;
    const ids = new Set(ctx.agents.map((a) => a.id));
    for (const id of [...this.agents.keys()]) if (!ids.has(id)) this.agents.delete(id);
    for (const info of ctx.agents) {
      const e = this.agents.get(info.id);
      if (!e) {
        this.agents.set(info.id, { info, activity: "idle", buildingId: homeOf(info) });
      } else {
        e.info = info;
        if (e.activity === "idle" || e.activity === "stopped") e.buildingId = homeOf(info);
      }
    }
  }

  applyRows(rows: ActionRow[], ctx: WorldCtx): void {
    this.plots = ctx.plots;
    for (const row of rows) {
      this.trackRun(row, ctx);
      const e = this.agents.get(row.agentId);
      if (e) this.applyRow(e, row, ctx);
    }
  }

  /** Keeps the progress panel list: one entry per top run, from run.started to run.stopped. */
  private trackRun(row: ActionRow, ctx: WorldCtx): void {
    if (!row.runId) return;
    const at = Date.parse(row.ts) || ctx.now;
    if (row.type === "run.started") {
      if (row.parentRunId) {
        const top = this.topOf.get(row.parentRunId);
        if (top === undefined) return;
        this.topOf.set(row.runId, top);
        const r = this.runs.get(top);
        if (r && !r.agents.includes(row.agentId)) r.agents.push(row.agentId);
        return;
      }
      const goal = (row.payload as { goal?: unknown } | null)?.goal;
      this.topOf.set(row.runId, row.runId);
      this.runs.set(row.runId, {
        runId: row.runId, projectId: row.projectId, agentId: row.agentId,
        goal: ctx.redactText(typeof goal === "string" ? goal : "").slice(0, GOAL_MAX),
        startedAt: row.ts, steps: 0, agents: [row.agentId], usd: 0, lastAt: at,
      });
      return;
    }
    const top = this.topOf.get(row.runId);
    const r = top === undefined ? undefined : this.runs.get(top);
    if (!r) return;
    r.lastAt = at;
    r.usd += row.usd;
    if (row.type === "tool.requested") {
      const call = (row.payload as { call?: { name?: unknown; args?: unknown } } | null)?.call;
      if (typeof call?.name === "string") {
        r.steps++;
        const arg = mainArg(call.name, call.args);
        r.lastTool = ctx.redactText(arg === undefined ? call.name : `${call.name} ${arg}`).slice(0, LAST_TEXT_MAX);
      }
    } else if (row.type === "tool.result") {
      const p = row.payload as { outcome?: unknown; result?: unknown } | null;
      if (typeof p?.result === "string") r.lastText = ctx.redactText(`${String(p.outcome)}: ${p.result.trim()}`).slice(0, GOAL_MAX);
    } else if (row.type === "run.stopped" && row.runId === top) {
      // Child runs of a stopped tree may log no stop of their own (Stop button), so their agents stop here.
      for (const e of this.agents.values()) {
        if (e.runId !== undefined && this.topOf.get(e.runId) === top && !rests(e.activity)) {
          e.stoppedAt = at;
          this.set(e, "stopped", homeOf(e.info));
        }
      }
      this.runs.delete(top);
      for (const [id, t] of this.topOf) if (t === top) this.topOf.delete(id);
    }
  }

  private set(e: Entry, activity: AgentActivity, buildingId: BuildingId): void {
    e.activity = activity;
    e.buildingId = buildingId;
  }

  private applyRow(e: Entry, row: ActionRow, ctx: WorldCtx): void {
    const a = e.info;
    switch (row.type) {
      case "run.started":
        e.projectId = row.projectId;
        e.runId = row.runId ?? undefined;
        e.lastText = undefined;
        e.stoppedAt = undefined;
        this.set(e, "thinking", workOf(a, "thinking", ctx.plots));
        return;
      case "model.call": {
        e.projectId = row.projectId;
        e.runId = row.runId ?? e.runId;
        const fresh = e.activity === "idle" || e.activity === "stopped";
        this.set(e, "thinking", fresh ? workOf(a, "thinking", ctx.plots) : e.buildingId);
        e.stoppedAt = undefined;
        return;
      }
      case "tool.requested": {
        const call = (row.payload as { call?: { name?: unknown; args?: unknown } } | null)?.call;
        const name = typeof call?.name === "string" ? call.name : undefined;
        const activity = name ? activityOf(name) : undefined;
        if (!name || !activity) return;
        e.projectId = row.projectId;
        e.runId = row.runId ?? e.runId;
        e.stoppedAt = undefined;
        const arg = mainArg(name, call?.args);
        e.lastText = ctx.redactText(arg === undefined ? name : `${name} ${arg}`).slice(0, LAST_TEXT_MAX);
        this.set(e, activity, buildingFor(a, activity, ctx.plots));
        return;
      }
      case "run.stopped":
        e.projectId = row.projectId;
        e.runId = row.runId ?? e.runId;
        e.stoppedAt = ctx.now;
        this.set(e, "stopped", homeOf(a));
        return;
      default:
        return;
    }
  }

  /**
   * Replayed history holds runs a restart or crash killed: they never logged run.stopped.
   * Their agents go home idle; a run still alive in another process shows again with its next row.
   */
  settleHistory(): void {
    for (const e of this.agents.values()) {
      if (rests(e.activity)) continue;
      e.lastText = undefined;
      e.runId = undefined;
      this.set(e, "idle", homeOf(e.info));
    }
    this.runs.clear();
    this.topOf.clear();
  }

  setApprovals(list: ApprovalView[], ctx: WorldCtx): void {
    this.plots = ctx.plots;
    this.approvals = list;
    this.waiting = new Set(list.map((x) => x.agentId));
  }

  tick(now: number): void {
    for (const [id, r] of this.runs) if (now - r.lastAt >= RUN_STALE_MS) this.runs.delete(id);
    for (const e of this.agents.values()) {
      if (e.activity === "stopped" && e.stoppedAt !== undefined && now - e.stoppedAt >= STOPPED_MS) {
        e.stoppedAt = undefined;
        e.lastText = undefined;
        this.set(e, "idle", homeOf(e.info));
      }
    }
  }

  state(): CityState {
    const agents: AgentView[] = [...this.agents.values()].map((e) => {
      const waiting = this.waiting.has(e.info.id);
      const v: AgentView = {
        id: e.info.id,
        name: e.info.name,
        role: e.info.role,
        building: e.info.building,
        activity: waiting ? "waiting_approval" : e.activity,
        buildingId: waiting ? "hq" : e.buildingId,
      };
      if (e.info.model !== undefined) v.model = e.info.model;
      if (e.projectId !== undefined) v.projectId = e.projectId;
      if (e.runId !== undefined) v.runId = e.runId;
      if (e.lastText !== undefined) v.lastText = e.lastText;
      return v;
    });
    const runs: RunView[] = [...this.runs.values()].map((r) => {
      const v: RunView & { lastAt?: number } = { ...r, agents: [...r.agents] };
      delete v.lastAt;
      return v;
    });
    return { agents, plots: this.plots.map((p) => ({ ...p })), approvals: this.approvals.map((x) => ({ ...x })), runs };
  }
}
