import type { AnyTool, GateDecision, ToolCall, ToolGate, Usage } from "@agentcity/core";
import type { ActionLog } from "./action-log.js";
import type { ApprovalQueue, Approver } from "./approvals.js";
import { dayKey, type Budget } from "./budget.js";
import { loadProjectConfig, type Connection, type ProjectConfig } from "./config.js";
import { costUsd, modelAllowed, priceFor, unmetered, type Prices } from "./pricing.js";
import type { RunTree } from "./run-tree.js";
import { effectiveTier } from "./policy.js";

type Role = "boss" | "manager" | "worker";

export interface GateDeps {
  home: string;
  projectId: string;
  agentId: string;
  log: ActionLog;
  budget: Budget;
  approvals: ApprovalQueue;
  approver: Approver;
  prices: Prices;
  /** OpenAI-compatible connections, for `api/` model prices. */
  connections?: Connection[];
  tree: RunTree;
  depth: number;
  runId: string;
  parentRunId?: string;
  roleOf: (agentId: string) => Role | undefined;
  canDelegate: (from: Role, to: Role) => boolean;
  plotTaken?: (plot: number) => boolean;
  /** The run asked for every edit to ask, whatever the project says. */
  askEdits?: boolean;
  /** The clock, for the day cap. Default: the real time. */
  now?: () => Date;
}

type Rule =
  | "config_invalid" | "kill_switch" | "agent_allowlist" | "allowlist" | "budget"
  | "tier0" | "tier1" | "user_approval" | "auto_approve" | "no_estimate" | "delegation" | "build";

/** An entry ending in * allows every tool whose name starts with the rest, e.g. mcp__gmail__*. */
/** Tools that only read, like read_file: a project that allows read_file allows these too. Older projects predate them. */
const READ_ALONGSIDE = new Set(["list_files", "search_files"]);

/** Board tools. Only the scheduler and the chat host attach them, so a project need not list them. */
const BOARD_TOOLS = new Set(["create_task", "update_task", "request_merge", "ask_player", "create_goal", "propose_plan"]);

export function toolAllowed(allowed: string[], name: string): boolean {
  if (READ_ALONGSIDE.has(name) && toolAllowed(allowed, "read_file")) return true;
  return allowed.some((a) => (a.endsWith("*") ? name.startsWith(a.slice(0, -1)) : a === name));
}

const allow: GateDecision = { kind: "allow" };
const deny = (reason: string): GateDecision => ({ kind: "deny", reason });
const stop = (reason: string): GateDecision => ({ kind: "stop", reason });

export class Gate implements ToolGate {
  /** Model of the last checkModelCall, for the local-model skip in checkTool. */
  private lastModel: string | undefined;

  constructor(private readonly d: GateDeps) {}

  private record(check: "tool" | "model", name: string, decision: GateDecision, rule: Rule): GateDecision {
    const payload: Record<string, unknown> = { check, name, decision: decision.kind, rule };
    if (decision.kind !== "allow") payload.reason = decision.reason;
    this.d.log.append({ projectId: this.d.projectId, agentId: this.d.agentId, type: "gate.decision", payload, ...this.runIds() });
    return decision;
  }

  private runIds(): { runId: string; parentRunId?: string } {
    return this.d.parentRunId === undefined
      ? { runId: this.d.runId }
      : { runId: this.d.runId, parentRunId: this.d.parentRunId };
  }

  // Checks 1 to 3 shared by tool and model calls. Returns a decision to stop, or the config.
  private common(check: "tool" | "model", name: string): { done: GateDecision } | { config: ProjectConfig } {
    const loaded = loadProjectConfig(this.d.home, this.d.projectId);
    if (!loaded.ok) return { done: this.record(check, name, stop("config_invalid"), "config_invalid") };
    const config = loaded.config;
    if (config.killSwitch) return { done: this.record(check, name, stop("killed"), "kill_switch") };
    if (!config.agents.includes(this.d.agentId)) {
      return { done: this.record(check, name, stop("agent_not_allowed"), "agent_allowlist") };
    }
    return { config };
  }

  /** The job cap (tokens of this run tree) and the day cap (dollars of the project today). 0 turns a cap off. Local models skip both. */
  private overBudget(config: ProjectConfig, model: string | undefined): "budget_job" | "budget_day" | undefined {
    if (model !== undefined && unmetered(model)) return undefined;
    const { jobTokens, dayUsd } = config.budget;
    if (jobTokens > 0 && this.d.tree.tokens >= jobTokens) return "budget_job";
    const today = dayKey((this.d.now ?? (() => new Date()))());
    if (dayUsd > 0 && this.d.budget.day(this.d.projectId, today).usd >= dayUsd) return "budget_day";
    return undefined;
  }

  async checkModelCall(req: { model: string; estimatedInputTokens: number }): Promise<GateDecision> {
    const r = this.common("model", req.model);
    if ("done" in r) return r.done;
    const config = r.config;
    if (!modelAllowed(config.allowedModels, req.model)) {
      return this.record("model", req.model, stop("model_not_allowed"), "allowlist");
    }
    if (priceFor(this.d.prices, req.model, this.d.connections) === undefined) {
      return this.record("model", req.model, stop("unknown_model_price"), "allowlist");
    }
    this.lastModel = req.model;
    const over = this.overBudget(config, req.model);
    if (over) return this.record("model", req.model, stop(over), "budget");
    return this.record("model", req.model, allow, "allowlist");
  }

  async recordUsage(model: string, usage: Usage): Promise<void> {
    const price = priceFor(this.d.prices, model, this.d.connections);
    const usd = price ? costUsd(price, usage) : 0;
    const tokens = usage.inputTokens + usage.outputTokens;
    this.d.budget.add(this.d.projectId, this.d.agentId, tokens, usd, dayKey((this.d.now ?? (() => new Date()))()));
    this.d.tree.addUsd(usd);
    this.d.tree.addTokens(tokens);
    this.d.log.append({
      projectId: this.d.projectId,
      agentId: this.d.agentId,
      type: "usage",
      payload: { model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      usd,
      ...this.runIds(),
    });
  }

  async checkTool(call: ToolCall, tool: AnyTool): Promise<GateDecision> {
    const name = call.name;
    const r = this.common("tool", name);
    if ("done" in r) return r.done;
    const config = r.config;
    // use_skill only reads the user's own skill files, and only skills attached to the agent.
    if (name !== "use_skill" && !BOARD_TOOLS.has(name) && !toolAllowed(config.allowedTools, name)) {
      return this.record("tool", name, deny("tool_not_allowed"), "allowlist");
    }
    const over = this.overBudget(config, this.lastModel);
    if (over) return this.record("tool", name, stop(over), "budget");

    if (name === "build" && this.d.plotTaken?.(Number((call.args as { plot?: unknown } | null)?.plot))) {
      return this.record("tool", name, deny("plot_taken"), "build");
    }

    const tier = effectiveTier(config, name, call.args, tool.tier, this.d.askEdits);
    if (tier === 0) return this.record("tool", name, allow, "tier0");
    if (tier === 1) return this.record("tool", name, allow, "tier1");

    const est = tool.estimateUsd ? tool.estimateUsd(call.args) : undefined;
    const req = {
      projectId: this.d.projectId,
      agentId: this.d.agentId,
      tool: name,
      args: call.args,
      tier,
      estimatedUsd: est ?? 0,
    };

    if (tier === 3) {
      if (est === undefined || !Number.isFinite(est) || est < 0) {
        return this.record("tool", name, deny("no_estimate"), "no_estimate");
      }
      const a = config.autoApprove;
      if (a.enabled && est <= a.maxUsdPerAction && this.d.approvals.autoTotalToday(this.d.projectId) + est <= a.maxUsdPerDay) {
        this.d.approvals.recordAuto(req);
        return this.record("tool", name, allow, "auto_approve");
      }
    }

    const status = await this.d.approvals.request(req, this.d.approver);
    return status === "approved"
      ? this.record("tool", name, allow, "user_approval")
      : this.record("tool", name, deny("user_denied"), "user_approval");
  }
}
