import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  runAgent, type AnyTool, type EventSink, type GateDecision, type Provider, type RunResult, type ToolGate, type Usage,
} from "@agentcity/core";
import { ActionLog, Budget, costUsd, dayKey, loadProjectConfig, priceFor, redact, unmetered, type GlobalConfig } from "@agentcity/safety";
import { AgentStore, buildSystemPrompt, CHAT_RULES, JOB_RULES, LEAD_DROPS, MemoryStore, makeRememberTool } from "@agentcity/org";
import { AgentSetup, connectGrantedMcp, NOTES_CHARS } from "./agent-setup.js";
import { formatEvent, providerFor } from "./shared.js";
import type { WebApprovals } from "./web-approver.js";

/** One board job: a plan, split, work, review or followup run of one agent. */
export interface Job {
  kind: "plan" | "tasks" | "split" | "work" | "review" | "followup";
  projectId: string;
  goalId: string;
  taskId?: string;
  agentId: string;
  prompt: string;
  /** Folder the file tools work in. The job's worktree. */
  cwd: string;
  /** Run id to use. The scheduler sets it so the task's run row exists before the run starts. */
  runId?: string;
  /** `chat`: a plain chat turn. Only read_file, list_files, search_files and remember, plus the tools passed to `run`. */
  tools?: "chat";
  /** Earlier turns of a chat, before `prompt`. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface JobRunnerDeps {
  home: string;
  db: Database.Database;
  secrets: string[];
  global: GlobalConfig;
  keys: Record<string, string>;
  providerOverride?: Provider;
  approvals: WebApprovals;
  out: (line: string) => void;
}

/** Leads plan, split and review. They get no write or command tools. */
const LEAD_KINDS: ReadonlySet<Job["kind"]> = new Set(["plan", "tasks", "split", "review"]);

/** The built-in tools a chat turn keeps. Chats never write files or run commands. */
const CHAT_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_files", "search_files", "remember"]);
/** A bare chat has no project config, so its step cap is fixed. A project run takes limits.stepsPerJob. */
const BARE_CHAT_MAX_STEPS = 20;
/** The step cap of a project chat when limits.stepsPerJob is 0. */
const PROJECT_CHAT_MAX_STEPS = 20;
/** What a chat without a project may spend. They have no project budget: one run gets this many tokens, and all of them together this many dollars a day. */
export const BARE_CHAT_JOB_TOKENS = 200_000;
export const BARE_CHAT_DAY_USD = 2;

/**
 * A gate for a chat without a project: no project config, so it allows the chat tool set and nothing else.
 * Tokens are counted per run (one gate per run). Dollars are kept under the empty project and capped per day.
 */
class BareChatGate implements ToolGate {
  private tokens = 0;
  constructor(
    private readonly log: ActionLog,
    private readonly ids: { projectId: string; agentId: string; runId: string },
    private readonly allowed: ReadonlySet<string>,
    private readonly budget: Budget,
    private readonly global: GlobalConfig,
  ) {}
  async checkModelCall(req: { model: string }): Promise<GateDecision> {
    // Local and subscription models are not billed per call, so they skip both caps.
    if (unmetered(req.model)) return { kind: "allow" };
    if (this.tokens >= BARE_CHAT_JOB_TOKENS) return { kind: "stop", reason: "budget_job" };
    if (this.budget.day("", dayKey(new Date())).usd >= BARE_CHAT_DAY_USD) return { kind: "stop", reason: "budget_day" };
    return { kind: "allow" };
  }
  async recordUsage(model: string, usage: Usage): Promise<void> {
    const price = priceFor(this.global.prices, model, this.global.connections);
    const tokens = usage.inputTokens + usage.outputTokens;
    this.tokens += tokens;
    this.budget.add("", this.ids.agentId, tokens, price ? costUsd(price, usage) : 0);
    this.log.append({ ...this.ids, type: "usage", payload: { model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });
  }
  async checkTool(call: { name: string }): Promise<GateDecision> {
    return this.allowed.has(call.name) ? { kind: "allow" } : { kind: "deny", reason: "tool_not_allowed" };
  }
}

/** Runs one board job as one agent run. The caller owns the board, the worktree and the inbox. */
export class JobRunner {
  constructor(private readonly d: JobRunnerDeps) {}

  /** `tools` are extra tools (board tools) added to the built-in set. `inbox` gives player messages sent during the run. */
  async run(job: Job, tools: AnyTool[], signal: AbortSignal, inbox: () => string[]): Promise<RunResult> {
    const { home, global, keys, secrets } = this.d;
    const runId = job.runId ?? randomBytes(6).toString("hex");
    if (job.tools === "chat" && job.projectId === "") return this.runBareChat(job, tools, signal, inbox, runId);
    const chat = job.tools === "chat";
    const setup = new AgentSetup({
      home, project: job.projectId, db: this.d.db, secrets, global, keys, providerOverride: this.d.providerOverride,
    });
    const loaded = loadProjectConfig(home, job.projectId);
    const allowed = loaded.ok ? loaded.config.allowedTools : [];
    // limits.stepsPerJob: 0 means no step cap for a board job. A project chat with 0 uses PROJECT_CHAT_MAX_STEPS.
    const stepLimit = loaded.ok ? loaded.config.limits.stepsPerJob : 0;
    const stepCap = chat ? (stepLimit > 0 ? stepLimit : PROJECT_CHAT_MAX_STEPS) : stepLimit === 0 ? Infinity : stepLimit;
    // A chat never uses MCP tools: it reads and remembers only.
    const hub = chat ? undefined : await connectGrantedMcp(home, global, keys, allowed, this.d.out);
    const logSink = setup.log.sink();
    const sink: EventSink = {
      emit: (e) => {
        logSink.emit(e);
        this.d.out(redact(formatEvent(e), secrets));
      },
    };
    try {
      const r = setup.prepare({
        agentId: job.agentId,
        depth: 0,
        runId,
        lead: LEAD_KINDS.has(job.kind),
        sandboxDir: job.cwd,
        mcpTools: hub?.tools ?? [],
        makeApprover: () => this.d.approvals.factory(),
      });
      if (!r.ok) return { reason: r.reason, steps: 0, usage: { inputTokens: 0, outputTokens: 0 }, runId, answer: "", ...(r.detail === undefined ? {} : { detail: r.detail }) };
      const { profile } = r;
      const lead = LEAD_KINDS.has(job.kind);
      const own = chat ? r.tools.filter((t) => CHAT_TOOLS.has(t.name)) : r.tools;
      // The prompt names exactly the tools the run has: an old project may still allow `delegate`, which no longer exists.
      const promptTools = [...new Set([...own, ...tools].map((t) => t.name))].filter((t) => !(lead && LEAD_DROPS.has(t)));
      // An abort denies this run's waiting approvals only. Other jobs keep theirs.
      const onAbort = () => r.approver.close();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await runAgent({
          provider: r.provider,
          model: r.model,
          tools: [...own, ...tools],
          gate: r.gate,
          events: sink,
          projectId: job.projectId,
          agentId: profile.id,
          runId,
          agentName: profile.name,
          agentVersion: profile.version,
          goal: job.prompt,
          maxSteps: stepCap,
          inbox,
          ...(job.history === undefined ? {} : { history: job.history }),
          systemPrompt: `${buildSystemPrompt(profile, { id: job.projectId, allowedTools: promptTools }, { notes: r.notes, skills: chat ? [] : r.skills })}\n${chat ? CHAT_RULES[profile.role] : JOB_RULES[profile.role]}`,
          toolContext: { projectId: job.projectId, agentId: profile.id, sandboxDir: r.sandboxDir, outboxDir: r.outboxDir, depth: 0, signal },
          signal,
        });
      } finally {
        signal.removeEventListener("abort", onAbort);
        r.approver.close();
      }
    } finally {
      await hub?.close();
    }
  }

  /** A chat without a project: the agent's notes, its remember tool and the tools given. There is no project config, budget or sandbox. */
  private async runBareChat(job: Job, tools: AnyTool[], signal: AbortSignal, inbox: () => string[], runId: string): Promise<RunResult> {
    const { home, global, keys, secrets } = this.d;
    const stop = (reason: string, detail?: string): RunResult =>
      ({ reason, steps: 0, usage: { inputTokens: 0, outputTokens: 0 }, runId, answer: "", ...(detail === undefined ? {} : { detail }) }) as RunResult;
    const profile = new AgentStore(home).get(job.agentId);
    if (!profile) return stop("target_missing");
    let wired: ReturnType<typeof providerFor>;
    try {
      wired = providerFor(profile.model, keys, global);
    } catch (e) {
      return stop("no_provider", e instanceof Error ? e.message : String(e));
    }
    const log = new ActionLog(this.d.db, secrets);
    const logSink = log.sink();
    const sink: EventSink = {
      emit: (e) => {
        logSink.emit(e);
        this.d.out(redact(formatEvent(e), secrets));
      },
    };
    const memory = new MemoryStore(home);
    const all: AnyTool[] = [makeRememberTool(memory, (s) => redact(s, secrets)), ...tools];
    const notes = memory.tail(profile.id, NOTES_CHARS);
    const system = [
      profile.persona,
      "",
      "This chat has no project. You cannot read project files.",
      `Tools you may use: ${all.map((t) => t.name).join(", ")}.`,
      CHAT_RULES[profile.role],
      ...(notes === "" ? [] : ["", `Your notes:\n${notes}`]),
    ].join("\n");
    return runAgent({
      provider: this.d.providerOverride ?? wired.provider,
      model: wired.model,
      tools: all,
      gate: new BareChatGate(log, { projectId: "", agentId: profile.id, runId }, new Set(all.map((t) => t.name)), new Budget(this.d.db), global),
      events: sink,
      projectId: "",
      agentId: profile.id,
      runId,
      agentName: profile.name,
      agentVersion: profile.version,
      goal: job.prompt,
      maxSteps: BARE_CHAT_MAX_STEPS,
      inbox,
      ...(job.history === undefined ? {} : { history: job.history }),
      systemPrompt: system,
      toolContext: { projectId: "", agentId: profile.id, sandboxDir: job.cwd, outboxDir: job.cwd, depth: 0, signal },
      signal,
    });
  }
}
