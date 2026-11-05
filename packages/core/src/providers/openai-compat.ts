// Request mapping follows AX Studio src/core/llm/openai-compatible-client.ts (MIT).
import type { ChatRequest, ChatResponse, Message, Provider, ToolCall } from "../types.js";

export class ProviderUnreachableError extends Error {
  baseUrl: string;
  constructor(baseUrl: string) {
    super(`Cannot reach ${baseUrl}. Is the server running?`);
    this.name = "ProviderUnreachableError";
    this.baseUrl = baseUrl;
  }
}

interface WireToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface WireResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: WireToolCall[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toWire(m: Message): Record<string, unknown> {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: {
                  name: c.name,
                  arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}),
                },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

function parseArgs(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  #baseUrl: string;
  #apiKey?: string;
  #fetchFn: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey?: string; fetch?: typeof fetch; id?: string }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#apiKey = opts.apiKey;
    this.#fetchFn = opts.fetch ?? globalThis.fetch;
    this.id = opts.id ?? "lmstudio";
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: req.model,
      messages: req.messages.map(toWire),
      max_tokens: req.maxTokens,
      stream: false,
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };
    let res: Response;
    try {
      res = await this.#fetchFn(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code === "ECONNREFUSED") throw new ProviderUnreachableError(this.#baseUrl);
      throw e;
    }
    if (!res.ok) {
      let text = await res.text();
      if (this.#apiKey) text = text.split(this.#apiKey).join("[secret]");
      text = text.slice(0, 500);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as WireResponse;
    const msg = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? "",
      args: parseArgs(c.function?.arguments),
    }));
    return {
      text: msg?.content ?? "",
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
