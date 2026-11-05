import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, type ChatRequest } from "@agentcity/core";

type Params = Anthropic.MessageCreateParamsNonStreaming;

function stub(content: unknown[] = [{ type: "text", text: "ok" }], usage = { input_tokens: 4, output_tokens: 2 }) {
  const calls: Params[] = [];
  const client = {
    messages: {
      create: async (p: Params) => {
        calls.push(p);
        return { content, usage };
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, calls };
}

const base: ChatRequest = { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 50 };

describe("AnthropicProvider", () => {
  it("sends system separately", async () => {
    const { client, calls } = stub();
    const p = new AnthropicProvider({ apiKey: "k", client });
    await p.chat({ ...base, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] });
    expect(p.id).toBe("anthropic");
    expect(calls[0]!.system).toBe("be brief");
    expect(calls[0]!.model).toBe("claude-haiku-5-5");
    expect(calls[0]!.max_tokens).toBe(50);
    expect(calls[0]!.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps tools to input_schema", async () => {
    const { client, calls } = stub();
    await new AnthropicProvider({ apiKey: "k", client }).chat({
      ...base,
      tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
    });
    expect(calls[0]!.tools).toEqual([
      { name: "read", description: "Read", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("maps tool results into one user message", async () => {
    const { client, calls } = stub();
    await new AnthropicProvider({ apiKey: "k", client }).chat({
      ...base,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "working",
          toolCalls: [
            { id: "a", name: "read", args: { p: 1 } },
            { id: "b", name: "read", args: { p: 2 } },
          ],
        },
        { role: "tool", toolCallId: "a", name: "read", content: "A" },
        { role: "tool", toolCallId: "b", name: "read", content: "B" },
      ],
    });
    expect(calls[0]!.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "a", name: "read", input: { p: 1 } },
          { type: "tool_use", id: "b", name: "read", input: { p: 2 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "A" },
          { type: "tool_result", tool_use_id: "b", content: "B" },
        ],
      },
    ]);
  });

  it("maps tool_use blocks back", async () => {
    const { client } = stub([
      { type: "text", text: "one" },
      { type: "tool_use", id: "t1", name: "read", input: { path: "x" } },
      { type: "text", text: "two" },
    ]);
    const res = await new AnthropicProvider({ apiKey: "k", client }).chat(base);
    expect(res.text).toBe("onetwo");
    expect(res.toolCalls).toEqual([{ id: "t1", name: "read", args: { path: "x" } }]);
  });

  it("maps usage", async () => {
    const { client } = stub(undefined, { input_tokens: 11, output_tokens: 5 });
    const res = await new AnthropicProvider({ apiKey: "k", client }).chat(base);
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
  });

  it("keeps the key out of JSON.stringify and inspect output", () => {
    const p = new AnthropicProvider({ apiKey: "sk-ant-secret-123" });
    expect(JSON.stringify(p)).not.toContain("sk-ant-secret-123");
    expect(inspect(p, { showHidden: true, depth: 5 })).not.toContain("sk-ant-secret-123");
  });

  it("sends no empty text block for an assistant message", async () => {
    const { client, calls } = stub();
    await new AnthropicProvider({ apiKey: "k", client }).chat({
      ...base,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", args: {} }] },
        { role: "tool", toolCallId: "a", name: "read", content: "A" },
        { role: "assistant", content: "" },
        { role: "user", content: "next" },
      ],
    });
    const msgs = calls[0]!.messages;
    expect(msgs[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }] });
    expect(msgs).toHaveLength(4);
    expect(msgs[3]).toEqual({ role: "user", content: "next" });
  });

  it("sends {} as input when args is an unparsed string", async () => {
    const { client, calls } = stub();
    await new AnthropicProvider({ apiKey: "k", client }).chat({
      ...base,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", args: "{bad" }] },
      ],
    });
    expect(calls[0]!.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "read", input: {} }],
    });
  });
});
