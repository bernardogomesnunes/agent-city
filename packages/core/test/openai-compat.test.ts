import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { OpenAICompatProvider, ProviderUnreachableError, type ChatRequest } from "@agentcity/core";

const req: ChatRequest = {
  model: "qwen",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { role: "tool", toolCallId: "c1", name: "read", content: "data" },
  ],
  tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
  maxTokens: 100,
};

function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (message: object, usage?: object) => ({ choices: [{ message }], ...(usage ? { usage } : {}) });

describe("OpenAICompatProvider", () => {
  it("posts to <baseUrl>/chat/completions with model and tools", async () => {
    const { fetch, calls } = stub(ok({ content: "yo" }));
    const p = new OpenAICompatProvider({ baseUrl: "http://localhost:1234/v1/", fetch });
    const res = await p.chat(req);
    expect(res.text).toBe("yo");
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/chat/completions");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("qwen");
    expect(body.max_tokens).toBe(100);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
    ]);
    expect(body.messages[2].tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
    ]);
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "data" });
    expect(p.id).toBe("lmstudio");
  });

  it("maps tool_calls back to ToolCall with parsed args", async () => {
    const { fetch } = stub(
      ok({ content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }] }),
    );
    const res = await new OpenAICompatProvider({ baseUrl: "http://h/v1", fetch }).chat(req);
    expect(res.text).toBe("");
    expect(res.toolCalls).toEqual([{ id: "c9", name: "read", args: { path: "x" } }]);
  });

  it("keeps unparsable arguments as a string", async () => {
    const { fetch } = stub(
      ok({ tool_calls: [{ id: "c9", type: "function", function: { name: "read", arguments: "{bad" } }] }),
    );
    const res = await new OpenAICompatProvider({ baseUrl: "http://h/v1", fetch }).chat(req);
    expect(res.toolCalls[0]!.args).toBe("{bad");
  });

  it("maps usage", async () => {
    const { fetch } = stub(ok({ content: "a" }, { prompt_tokens: 7, completion_tokens: 3 }));
    const p = new OpenAICompatProvider({ baseUrl: "http://h/v1", fetch });
    expect((await p.chat(req)).usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    const none = stub(ok({ content: "a" }));
    const q = new OpenAICompatProvider({ baseUrl: "http://h/v1", fetch: none.fetch });
    expect((await q.chat(req)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("throws ProviderUnreachableError on ECONNREFUSED", async () => {
    const fetch = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof globalThis.fetch;
    const p = new OpenAICompatProvider({ baseUrl: "http://localhost:1234/v1", fetch });
    const err = await p.chat(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnreachableError);
    expect(err.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("throws HTTP error on 500", async () => {
    const { fetch } = stub("x".repeat(600), 500);
    const err = await new OpenAICompatProvider({ baseUrl: "http://h/v1", fetch }).chat(req).catch((e) => e);
    expect(err.message).toBe(`HTTP 500: ${"x".repeat(500)}`);
  });

  it("keeps the key out of JSON.stringify and inspect output", () => {
    const p = new OpenAICompatProvider({ baseUrl: "http://h/v1", apiKey: "sk-secret-123" });
    expect(JSON.stringify(p)).not.toContain("sk-secret-123");
    expect(inspect(p, { showHidden: true, depth: 5 })).not.toContain("sk-secret-123");
  });

  it("replaces the key with [secret] in HTTP error text", async () => {
    const { fetch } = stub("bad key sk-secret-123 rejected", 401);
    const err = await new OpenAICompatProvider({ baseUrl: "http://h/v1", apiKey: "sk-secret-123", fetch })
      .chat(req)
      .catch((e) => e);
    expect(err.message).toBe("HTTP 401: bad key [secret] rejected");
  });
});
