import type Database from "better-sqlite3";
import {
  builtInTools,
  type AnyTool,
  type Provider,
} from "@agentcity/core";
import {
  ActionLog,
  ApprovalQueue,
  Budget,
  Gate,
  RunTree,
  loadProjectConfig,
  projectDirs,
  redact,
  toolAllowed,
  CityPlots,
  type GlobalConfig,
  type ProjectConfig,
} from "@agentcity/safety";
import {
  AgentStore,
  MemoryStore,
  SkillStore,
  makeUseSkillTool,
  canDelegate,
  makeBuildTool,
  makeRememberTool,
  LEAD_DROPS,
  type AgentProfile,
} from "@agentcity/org";
import type { ClosableApprover } from "./approver.js";
import { providerFor } from "./shared.js";
import { workDir } from "./workspace.js";
import { McpHub } from "./mcp.js";

/** Prompt budget for the agent's notes file. */
export const NOTES_CHARS = 4000;
const DEFAULT_DELEGATION = { maxDepth: 3, maxTreeUsd: 0.5, maxChildRuns: 10 };

export interface AgentSetupDeps {
  home: string;
  project: string;
  db: Database.Database;
  secrets: string[];
  global: GlobalConfig;
  keys: Record<string, string>;
  providerOverride?: Provider;
}

export interface SetupRequest {
  agentId: string;
  depth: number;
  runId: string;
  parentRunId?: string;
  /** Replaces the agent's model for this run. */
  modelOverride?: string;
  /** Drops file write, edit, delete and command tools. Default: false. Job runs set it for plan, split and review. */
  lead?: boolean;
  /** Folder the file tools work in. Default: the project's work folder. */
  sandboxDir?: string;
  /** Tools from MCP servers the project grants. */
  mcpTools: AnyTool[];
  /** Builds the approver for this run. The caller closes it. */
  makeApprover: (agentName: string) => ClosableApprover;
  /** Every write and edit asks in this run. */
  askEdits?: boolean;
  /** Called with each provider error the model call throws. */
  onProviderError?: (e: unknown) => void;
}

export type SetupResult =
  | { ok: false; reason: string; detail?: string }
  | {
      ok: true;
      profile: AgentProfile;
      provider: Provider;
      model: string;
      /** Built-in tools the project allows, MCP tools, remember, use_skill and build. */
      tools: AnyTool[];
      gate: Gate;
      approver: ClosableApprover;
      config?: ProjectConfig;
      allowedTools: string[];
      skills: Array<{ name: string; description: string }>;
      notes: string;
      sandboxDir: string;
      outboxDir: string;
    };

/** Connects the MCP servers that the allowed tools name. Undefined when none. Call `close` on the result. */
export async function connectGrantedMcp(
  home: string,
  global: GlobalConfig,
  keys: Record<string, string>,
  allowedTools: string[],
  warn: (line: string) => void,
): Promise<McpHub | undefined> {
  const servers = global.mcpServers.filter((s) => allowedTools.some((a) => a.startsWith(`mcp__${s.name}__`)));
  return servers.length > 0 ? McpHub.connect(servers, keys, warn, home) : undefined;
}

/** Everything one agent run needs besides its goal: provider, tools, gate, approver and prompt parts. One per tree or job. */
export class AgentSetup {
  readonly tree: RunTree;
  readonly agents: AgentStore;
  readonly memory: MemoryStore;
  readonly log: ActionLog;
  readonly approvals: ApprovalQueue;
  readonly budget: Budget;
  readonly plots: CityPlots;

  constructor(private readonly d: AgentSetupDeps) {
    const cfg = loadProjectConfig(d.home, d.project);
    this.tree = new RunTree(cfg.ok ? cfg.config.delegation : DEFAULT_DELEGATION);
    this.agents = new AgentStore(d.home);
    this.memory = new MemoryStore(d.home);
    this.log = new ActionLog(d.db, d.secrets);
    this.approvals = new ApprovalQueue(d.db, d.secrets);
    this.budget = new Budget(d.db);
    this.plots = new CityPlots(d.db);
  }

  prepare(req: SetupRequest): SetupResult {
    const { home, project, global, keys } = this.d;
    const profile = this.agents.get(req.agentId);
    if (!profile) return { ok: false, reason: "target_missing" };

    const model = req.modelOverride ?? profile.model;
    let wired: { provider: Provider; model: string };
    try {
      wired = providerFor(model, keys, global);
    } catch (e) {
      return { ok: false, reason: "no_provider", detail: e instanceof Error ? e.message : String(e) };
    }
    const inner = this.d.providerOverride ?? wired.provider;
    const provider: Provider = {
      id: inner.id,
      chat: async (r) => {
        try {
          return await inner.chat(r);
        } catch (e) {
          req.onProviderError?.(e);
          throw e;
        }
      },
    };

    const loaded = loadProjectConfig(home, project);
    const config: ProjectConfig | undefined = loaded.ok ? loaded.config : undefined;
    const allowedTools = config?.allowedTools ?? [];
    // A lead reads but does not change files or run commands. Only tools the project allows:
    // a model offered a tool the gate refuses tells the player it has no file access.
    const lead = req.lead === true;
    const own = builtInTools.filter((t) => toolAllowed(allowedTools, t.name) && !(lead && LEAD_DROPS.has(t.name)));
    const tools: AnyTool[] = [...own, ...req.mcpTools];
    if (allowedTools.includes("remember")) tools.push(makeRememberTool(this.memory, (s) => redact(s, this.d.secrets)));
    // Skills that still exist on disk; a removed skill drops out of the prompt.
    const skillStore = new SkillStore(home);
    const skills = skillStore.list().filter((s) => profile.skills.includes(s.name));
    if (skills.length > 0) tools.push(makeUseSkillTool((n) => skillStore.get(n)?.body, skills.map((s) => s.name)));
    if (allowedTools.includes("build")) {
      tools.push(
        makeBuildTool((plot, kind, ctx) =>
          this.plots.claim({ plot, kind, projectId: ctx.projectId, agentId: ctx.agentId }),
        ),
      );
    }

    const approver = req.makeApprover(profile.name);
    const gate = new Gate({
      home, projectId: project, agentId: profile.id, log: this.log, budget: this.budget,
      approvals: this.approvals, approver, prices: global.prices, connections: global.connections,
      plotTaken: (n) => this.plots.taken(n),
      askEdits: req.askEdits,
      tree: this.tree, depth: req.depth, runId: req.runId, parentRunId: req.parentRunId,
      roleOf: (id) => this.agents.get(id)?.role,
      canDelegate,
    });

    const dirs = projectDirs(home, project);
    return {
      ok: true,
      profile,
      provider,
      model: wired.model,
      tools,
      gate,
      approver,
      config,
      allowedTools,
      skills,
      notes: this.memory.tail(profile.id, NOTES_CHARS),
      sandboxDir: req.sandboxDir ?? workDir(home, config, project),
      outboxDir: dirs.outbox,
    };
  }
}
