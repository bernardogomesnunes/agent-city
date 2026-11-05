import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  runAgent,
  type AnyTool,
  type EventSink,
  type Provider,
  type RunResult,
} from "@agentcity/core";
import {
  loadProjectConfig,
  redact,
  type GlobalConfig,
} from "@agentcity/safety";
import { buildSystemPrompt } from "@agentcity/org";
import { LineReader, TerminalApprover, type ClosableApprover } from "./approver.js";
import { formatEvent, type CliIo } from "./shared.js";
import { prepareWorkspace } from "./workspace.js";
import { AgentSetup, connectGrantedMcp } from "./agent-setup.js";

export interface TreeRunnerDeps {
  home: string;
  project: string;
  db: Database.Database;
  secrets: string[];
  global: GlobalConfig;
  keys: Record<string, string>;
  providerOverride?: Provider;
  io: CliIo;
  out: (line: string) => void;
  signal: AbortSignal;
  /** Builds the approver for one agent run. Default: a terminal approver on the shared line reader. */
  approverFactory?: (agentName: string) => ClosableApprover;
  /** Every write and edit asks in this run, whatever the project says. */
  askEdits?: boolean;
}

const noRun = (runId: string, reason: string, detail?: string): RunResult => {
  const r: RunResult = { reason, steps: 0, usage: { inputTokens: 0, outputTokens: 0 }, runId, answer: "" };
  if (detail !== undefined) r.detail = detail;
  return r;
};

/** Runs one agent as the top of a run. The run tree, log and approval queue live on the setup. */
export class TreeRunner {
  private readonly setup: AgentSetup;
  private readonly approvers = new Set<ClosableApprover>();
  private readonly sink: EventSink;
  private readonly reader: LineReader;
  private lastError: unknown;
  private top?: { agentId: string; runId: string };
  private topStopped = false;
  private branch?: string;
  private mcpTools: AnyTool[] = [];

  constructor(private readonly d: TreeRunnerDeps) {
    this.setup = new AgentSetup({
      home: d.home, project: d.project, db: d.db, secrets: d.secrets, global: d.global, keys: d.keys, providerOverride: d.providerOverride,
    });
    this.reader = new LineReader(d.io.input, false);
    const logSink = this.setup.log.sink();
    this.sink = {
      emit: (e) => {
        if (e.type === "run.stopped" && this.top && e.runId === this.top.runId) this.topStopped = true;
        logSink.emit(e);
        d.out(redact(formatEvent(e), d.secrets));
      },
    };
  }

  /** Runs the agent once with its goal. `model` replaces the agent's model for this run. */
  async run(agentId: string, goal: string, opts: { model?: string } = {}): Promise<RunResult> {
    const runId = randomBytes(6).toString("hex");
    this.top = { agentId, runId };
    const cfg = loadProjectConfig(this.d.home, this.d.project);
    const ws = prepareWorkspace(cfg.ok ? cfg.config : undefined, agentId);
    if (!ws.ok) return noRun(runId, ws.reason, ws.detail);
    if (ws.branch) {
      this.branch = ws.branch;
      this.setup.log.append({ projectId: this.d.project, agentId, type: "workspace.branch", payload: { branch: ws.branch }, runId });
      this.d.out(`working on branch ${ws.branch}`);
    }
    // Connect only the MCP servers this project grants.
    const allowed = cfg.ok ? cfg.config.allowedTools : [];
    const hub = await connectGrantedMcp(this.d.home, this.d.global, this.d.keys, allowed, this.d.out);
    this.mcpTools = hub?.tools ?? [];
    try {
      return await this.runOne(agentId, goal, runId, opts.model);
    } finally {
      await hub?.close();
    }
  }

  /** Denies every pending approval and cancels every prompt. Safe to call twice. */
  cancelAll(): void {
    this.setup.approvals.denyAllPending();
    for (const a of this.approvers) a.cancel();
  }

  closeAll(): void {
    for (const a of this.approvers) a.close();
    this.approvers.clear();
    this.reader.close();
  }

  lastProviderError(): unknown {
    return this.lastError;
  }

  /** Logs `run.stopped: interrupted` for the top run if it has not logged a stop itself. */
  markInterrupted(): void {
    if (!this.top || this.topStopped) return;
    this.topStopped = true;
    this.setup.log.append({
      projectId: this.d.project,
      agentId: this.top.agentId,
      type: "run.stopped",
      payload: { reason: "interrupted", steps: 0 },
      runId: this.top.runId,
    });
  }

  private async runOne(agentId: string, goal: string, runId: string, modelOverride?: string): Promise<RunResult> {
    const { project } = this.d;
    const setup = this.setup.prepare({
      agentId,
      depth: 0,
      runId,
      modelOverride,
      mcpTools: this.mcpTools,
      makeApprover: (name) => {
        const a = this.d.approverFactory?.(name) ?? new TerminalApprover(this.d.io, name, this.reader);
        this.approvers.add(a);
        return a;
      },
      askEdits: this.d.askEdits,
      onProviderError: (e) => {
        this.lastError = e;
      },
    });
    if (!setup.ok) return noRun(runId, setup.reason, setup.detail);

    const { profile, provider, model, gate, approver, config, allowedTools, skills, notes, sandboxDir, outboxDir } = setup;

    try {
      return await runAgent({
        provider,
        model,
        tools: setup.tools,
        gate,
        events: this.sink,
        projectId: project,
        agentId: profile.id,
        runId,
        agentName: profile.name,
        agentVersion: profile.version,
        goal,
        systemPrompt: buildSystemPrompt(profile, { id: project, allowedTools }, {
          notes,
          workspace: config?.workspace ? { branch: this.branch } : undefined,
          skills,
        }),
        toolContext: { projectId: project, agentId: profile.id, sandboxDir, outboxDir, depth: 0, signal: this.d.signal },
        signal: this.d.signal,
      });
    } finally {
      approver.close();
      this.approvers.delete(approver);
    }
  }
}
