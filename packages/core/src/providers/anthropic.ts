import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatResponse, Message, Provider, ToolCall } from "../types.js";

type Param = Anthropic.MessageParam;

function toWire(messages: Message[]): { system?: string; messages: Param[] } {
  const system: string[] = [];
  const out: Param[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system.push(m.content);
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: typeof c.args === "string" || c.args == null ? {} : c.args });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return { ...(system.length ? { system: system.join("\n\n") } : {}), messages: out };
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  #client: Pick<Anthropic, "messages">;

  constructor(opts: { apiKey: string; client?: Pick<Anthropic, "messages"> }) {
    this.#client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { system, messages } = toWire(req.messages);
    const res = await this.#client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
    });
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const b of res.content) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input });
    }
    return {
      text,
      toolCalls,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}
