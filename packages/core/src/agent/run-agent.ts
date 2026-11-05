import { randomBytes } from "node:crypto";
import type { AgentEvent, EventSink } from "../events.js";
import type { ChatResponse, Message, Provider, ToolCall, Usage } from "../types.js";
import { estimateMessages, shortenOldResults, trimMessages } from "../llm/trim.js";
import { parseTextToolCalls } from "../llm/text-tool-calls.js";
import { toolSpec, type AnyTool, type ToolContext, type ToolGate } from "../tools/types.js";

export interface RunAgentOptions {
  provider: Provider; model: string; tools: AnyTool[]; gate: ToolGate; events: EventSink;
  projectId: string; agentId: string; agentName: string; agentVersion: number; goal: string; toolContext: ToolContext;
  systemPrompt?: string;
  /** Model calls the run may make. Infinity means no step cap. */
  maxSteps?: number; contextWindow?: number; maxTokens?: number;
  sleep?: (ms: number) => Promise<void>; signal?: AbortSignal;
  runId?: string; parentRunId?: string;
  /** Earlier turns of a conversation, oldest first. They go between the system prompt and the goal. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Messages the player sent while the run works. Called after each batch of tool results. */
  inbox?: () => string[];
}
export interface RunResult { reason: string; steps: number; usage: Usage; runId: string; answer: string; detail?: string }

export const DEFAULT_SYSTEM_PROMPT =
  "You are an agent working inside a sandboxed project. Use the provided tools to reach the goal. " +
  "Call a tool only when you need it. When the goal is met, reply with a short final answer and no tool call.";

const RETRY_WAITS = [1000, 4000];
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type EventBody = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, "ts" | "projectId" | "agentId" | "runId" | "parentRunId"> : never) : never;

export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const {
    provider, model, tools, gate, events, projectId, agentId, goal, toolContext,
    maxSteps = 20, contextWindow = 32000, maxTokens = 4096, sleep = defaultSleep, signal, parentRunId,
  } = opts;
  const runId = opts.runId ?? randomBytes(6).toString("hex");
  const endState = { ended: false };
  const runToolContext: ToolContext = { ...toolContext, runId, endRun: () => { endState.ended = true; } };
  const emit = (e: EventBody) =>
    events.emit({ ts: new Date().toISOString(), projectId, agentId, runId, parentRunId, ...e } as AgentEvent);
  const specs = tools.map(toolSpec);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolNames = tools.map((t) => t.name);
  const messages: Message[] = [
    { role: "system", content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ...fitHistory(opts.history ?? [], specs, contextWindow),
    { role: "user", content: goal },
  ];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;

  emit({ type: "run.started", goal, model, agentName: opts.agentName, agentVersion: opts.agentVersion });
  let lastError: unknown;
  const finish = (reason: string): RunResult => {
    const answer = messages.findLast((m) => m.role === "assistant" && m.content.trim() !== "")?.content ?? "";
    const detail = reason === "provider_error" && lastError !== undefined
      ? (lastError instanceof Error ? lastError.message : String(lastError))
      : undefined;
    emit(detail === undefined ? { type: "run.stopped", reason, steps } : { type: "run.stopped", reason, steps, detail });
    return detail === undefined ? { reason, steps, usage, runId, answer } : { reason, steps, usage, runId, answer, detail };
  };

  while (true) {
    if (signal?.aborted) return finish("interrupted");
    if (steps >= maxSteps) return finish("max_steps");
    steps++;

    const trimmed = trimMessages(shortenOldResults(messages), specs, contextWindow);
    const decision = await gate.checkModelCall({ model, estimatedInputTokens: estimateMessages(trimmed, specs) });
    if (decision.kind !== "allow") return finish(decision.kind === "stop" || decision.kind === "deny" ? decision.reason : "invalid_gate_decision");

    emit({ type: "model.call", model, messageCount: trimmed.length });
    let res: ChatResponse | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await provider.chat({ model, messages: trimmed, tools: specs, maxTokens, signal });
        break;
      } catch (err) {
        lastError = err;
        if (attempt >= RETRY_WAITS.length) break;
        await sleep(RETRY_WAITS[attempt]);
      }
    }
    if (!res) return finish("provider_error");

    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    await gate.recordUsage(model, res.usage);

    let text = res.text;
    let calls: ToolCall[] = res.toolCalls ?? [];
    if (calls.length === 0 && text) {
      const parsed = parseTextToolCalls(text, toolNames);
      if (parsed.calls.length) {
        calls = parsed.calls;
        text = parsed.rest;
      }
    }
    emit({ type: "model.result", usage: res.usage, toolCallCount: calls.length, ...(calls.length === 0 ? { preview: text.slice(0, 1200) } : {}) });
    if (calls.length === 0) {
      messages.push({ role: "assistant", content: text });
      return finish("done");
    }
    messages.push({ role: "assistant", content: text, toolCalls: calls });

    for (const call of calls) {
      if (signal?.aborted) return finish("interrupted");
      emit({ type: "tool.requested", call });
      const result = (outcome: "ok" | "denied" | "error", content: string) => {
        emit({ type: "tool.result", callId: call.id, name: call.name, outcome, result: content });
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      };
      const tool = byName.get(call.name);
      if (!tool) {
        result("error", `error: unknown tool ${call.name}`);
        continue;
      }
      const parsed = tool.schema.safeParse(call.args);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
        result("error", `error: invalid arguments: ${issues.join("; ")}`);
        continue;
      }
      if (signal?.aborted) return finish("interrupted");
      const verdict = await gate.checkTool(call, tool);
      if (signal?.aborted) return finish("interrupted");
      if (verdict.kind === "stop") return finish(verdict.reason);
      if (verdict.kind === "deny") {
        result("denied", `denied: ${verdict.reason}`);
        continue;
      }
      if (verdict.kind !== "allow") return finish("invalid_gate_decision");
      try {
        result("ok", await tool.run(parsed.data, runToolContext));
      } catch (err) {
        result("error", `error: ${err instanceof Error ? err.message : String(err)}`);
      }
      // The tool ended the run. The calls after it in this batch do not run.
      if (endState.ended) return finish("done");
    }
    const waiting = opts.inbox?.() ?? [];
    if (waiting.length > 0) {
      messages.push({ role: "user", content: waiting.map((t) => `Message from the player: ${t}`).join("\n\n") });
      emit({ type: "inbox", count: waiting.length });
    }
  }
}

/**
 * Earlier turns that fit in half the context window, keeping the newest. The other half stays free for
 * this turn's tool calls, which trimMessages drops oldest first.
 */
function fitHistory(history: Array<{ role: "user" | "assistant"; content: string }>, specs: ReturnType<typeof toolSpec>[], windowTokens: number): Message[] {
  let list: Message[] = history.map((h) => ({ role: h.role, content: h.content }));
  while (list.length > 0 && estimateMessages(list, specs) > windowTokens / 2) list = list.slice(1);
  // Start on a player message, so the model never sees an answer to nothing.
  while (list.length > 0 && list[0]!.role !== "user") list = list.slice(1);
  return list;
}
