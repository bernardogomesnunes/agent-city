import {
  AnthropicProvider,
  ClaudeCliProvider,
  OpenAICompatProvider,
  type AgentEvent,
  type ChatRequest,
  type Provider,
} from "@agentcity/core";
import { parseModelId } from "@agentcity/org";
import type { GlobalConfig } from "@agentcity/safety";

export interface CliIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
}

const SUB_PREFIX = "claude-sub/";
const LM_PREFIX = "lmstudio/";
const API_PREFIX = "api/";
export const NO_ANTHROPIC_KEY = "No Anthropic key. Run: agentcity secrets set anthropic";

/** Wraps a provider so the wire model drops `prefix`. */
const stripping = (inner: Provider, prefix: string): Provider => ({
  id: inner.id,
  chat: (req: ChatRequest) => inner.chat({ ...req, model: req.model.slice(prefix.length) }),
});

/**
 * Picks the provider for a model id: `claude-sub/` runs the local claude binary, `lmstudio/` LM Studio,
 * `api/<connection>/` an OpenAI-compatible connection, anything else the Anthropic API.
 * The returned model is the full id the gate sees (allowlist and price lookups); providers strip prefixes on the wire.
 */
export function providerFor(
  model: string,
  secrets: Record<string, string>,
  global: GlobalConfig,
): { provider: Provider; model: string } {
  if (model.startsWith(SUB_PREFIX)) {
    const r = parseModelId(model, []);
    if (!r.ok) throw new Error(r.error);
    return { provider: new ClaudeCliProvider({ claudePath: global.claudePath, alias: model.slice(SUB_PREFIX.length) }), model };
  }
  if (model.startsWith(LM_PREFIX)) {
    return { provider: stripping(new OpenAICompatProvider({ baseUrl: global.lmStudioBaseUrl, apiKey: secrets.lmstudio }), LM_PREFIX), model };
  }
  if (model.startsWith(API_PREFIX)) {
    const name = model.slice(API_PREFIX.length).split("/")[0]!;
    const c = global.connections.find((x) => x.name === name);
    if (!c) throw new Error(`No connection ${name}. Run: agentcity connection add ${name} <baseUrl>`);
    const inner = new OpenAICompatProvider({ baseUrl: c.baseUrl, apiKey: secrets[`api-${name}`], id: `api-${name}` });
    return { provider: stripping(inner, `${API_PREFIX}${name}/`), model };
  }
  const apiKey = secrets.anthropic;
  if (!apiKey) throw new Error(NO_ANTHROPIC_KEY);
  return { provider: new AnthropicProvider({ apiKey }), model };
}

const clip = (s: string, n = 100): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 3) + "..." : one;
};

const hhmmss = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function formatEvent(e: AgentEvent): string {
  let detail: string;
  switch (e.type) {
    case "run.started": detail = `${e.agentName} v${e.agentVersion} ${e.model}: ${clip(e.goal)}`; break;
    case "model.call": detail = `${e.model} ${e.messageCount} messages`; break;
    case "model.result": detail = `${e.usage.inputTokens} in, ${e.usage.outputTokens} out, ${e.toolCallCount} tool calls`; break;
    case "tool.requested": detail = `${e.call.name} ${clip(JSON.stringify(e.call.args))}`; break;
    case "tool.result": detail = `${e.name} ${e.outcome} ${clip(e.result)}`; break;
    case "inbox": detail = `${e.count} message(s) from the player`; break;
    case "run.stopped": detail = `${e.reason} after ${e.steps} steps`; break;
  }
  return `[${hhmmss(e.ts)}] ${e.type} ${detail}`;
}
