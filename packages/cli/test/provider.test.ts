import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@agentcity/core";
import { loadGlobalConfig } from "@agentcity/safety";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerFor } from "../src/wire.js";

const global = loadGlobalConfig(fs.mkdtempSync(path.join(os.tmpdir(), "ac-prov-")));

afterEach(() => vi.unstubAllGlobals());

describe("providerFor", () => {
  it("lmstudio/qwen routes to LM Studio and sends model qwen", async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })),
    );
    vi.stubGlobal("fetch", fetchStub);
    const { provider, model } = providerFor("lmstudio/qwen", {}, global);
    expect(provider.id).toBe("lmstudio");
    expect(model).toBe("lmstudio/qwen");
    await provider.chat({ model, messages: [{ role: "user", content: "x" }], tools: [], maxTokens: 10 });
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe("qwen");
  });

  it("sends the lmstudio key to LM Studio", async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    vi.stubGlobal("fetch", fetchStub);
    const { provider, model } = providerFor("lmstudio/qwen", { lmstudio: "lm-fake" }, global);
    await provider.chat({ model, messages: [{ role: "user", content: "x" }], tools: [], maxTokens: 10 });
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer lm-fake");
  });

  it("claude-haiku-5-5 routes to Anthropic", () => {
    const { provider, model } = providerFor("claude-haiku-5-5", { anthropic: "sk-ant-test" }, global);
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(model).toBe("claude-haiku-5-5");
  });

  it("rejects an unknown claude-sub alias before spawning", () => {
    expect(() => providerFor("claude-sub/%X%", {}, global)).toThrow("unknown subscription model %X%");
  });

  it("routes claude-sub to the claude provider", () => {
    const { provider, model } = providerFor("claude-sub/haiku", {}, global);
    expect(provider.id).toBe("claude-sub");
    expect(model).toBe("claude-sub/haiku");
  });

  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const withConns = { ...global, connections: [{ name: "groq", baseUrl: "https://g/v1" }, { name: "free", baseUrl: "http://o/v1" }] };

  it("routes api to its connection, strips the prefix and sends the key", async () => {
    const fetchStub = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchStub);
    const { provider, model } = providerFor("api/groq/meta/llama", { "api-groq": "k" }, withConns);
    expect(provider.id).toBe("api-groq");
    expect(model).toBe("api/groq/meta/llama");
    await provider.chat({ model, messages: [{ role: "user", content: "x" }], tools: [], maxTokens: 10 });
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe("https://g/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe("meta/llama");
    expect(init.headers.authorization ?? init.headers.Authorization).toBe("Bearer k");
  });

  it("sends no Authorization header without a key", async () => {
    const fetchStub = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchStub);
    const { provider, model } = providerFor("api/free/m", {}, withConns);
    await provider.chat({ model, messages: [{ role: "user", content: "x" }], tools: [], maxTokens: 10 });
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("throws for a removed connection", () => {
    expect(() => providerFor("api/gone/m", {}, withConns)).toThrow("No connection gone. Run: agentcity connection add gone <baseUrl>");
  });

  it("missing anthropic key throws the hint", () => {
    expect(() => providerFor("claude-haiku-5-5", {}, global)).toThrow("No Anthropic key. Run: agentcity secrets set anthropic");
  });
});
