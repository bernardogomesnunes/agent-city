import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGlobalConfig } from "@agentcity/safety";
import { listModels } from "../src/models.js";

const base = loadGlobalConfig(fs.mkdtempSync(path.join(os.tmpdir(), "ac-models-")));
const global = { ...base, connections: [{ name: "groq", baseUrl: "https://g/v1" }] };
const list = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }));

const ready = { path: "/opt/claude", signedIn: true };

describe("listModels", () => {
  it("lists the groups in order with prefixed ids", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("http://localhost:1234") ? list(["qwen/qwen3-14b"]) : list(["llama"]));
    const groups = await listModels(global, {}, fetchFn as unknown as typeof fetch, ready);
    expect(groups).toEqual([
      { label: "Claude subscription", models: ["claude-sub/sonnet", "claude-sub/opus", "claude-sub/haiku"] },
      { label: "LM Studio", models: ["lmstudio/qwen/qwen3-14b"] },
      { label: "API: groq", models: ["api/groq/llama"] },
      { label: "Anthropic API", models: ["claude-haiku-5-5"] },
    ]);
    expect((fetchFn.mock.calls as unknown as [string][]).map((c) => String(c[0]))).toEqual(["http://localhost:1234/v1/models", "https://g/v1/models"]);
  });

  it("returns the other groups when LM Studio never answers, within the timeout", async () => {
    const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("http://localhost:1234")) return Promise.resolve(list(["llama"]));
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    const t0 = Date.now();
    const groups = await listModels(global, {}, fetchFn as unknown as typeof fetch, ready);
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(groups[1]).toEqual({ label: "LM Studio", models: [], error: "cannot reach http://localhost:1234/v1" });
    expect(groups[2]).toEqual({ label: "API: groq", models: ["api/groq/llama"] });
  });

  it("reports a 401 with no key as needs a key, per group", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    const groups = await listModels(global, {}, fetchFn as unknown as typeof fetch, ready);
    expect(groups[2]).toEqual({ label: "API: groq", models: [], error: "needs a key" });
  });

  it("sends the connection key and never returns it", async () => {
    const fetchFn = vi.fn(async () => list(["llama"]));
    const groups = await listModels(global, { "api-groq": "k-secret" }, fetchFn as unknown as typeof fetch, ready);
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    const groqInit = calls.find((c) => String(c[0]).startsWith("https://g"))![1];
    expect((groqInit.headers as Record<string, string>).Authorization).toBe("Bearer k-secret");
    const lmInit = calls.find((c) => String(c[0]).startsWith("http://localhost"))![1];
    expect(lmInit.headers ?? {}).not.toHaveProperty("Authorization");
    expect(JSON.stringify(groups)).not.toContain("k-secret");
  });

  it("marks the Claude subscription group until claude is installed and signed in", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("down"); });
    const sub = async (s: { path: string | null; signedIn: boolean | null }) => (await listModels(global, {}, fetchFn as unknown as typeof fetch, s))[0];
    expect((await sub({ path: null, signedIn: false })).error).toBe("not installed: set up in HQ, APIs");
    expect((await sub({ path: "c", signedIn: false })).error).toBe("not signed in: set up in HQ, APIs");
    expect((await sub({ path: "c", signedIn: null })).error).toBeUndefined();
  });
});

describe("listModels replies and keys", () => {
  const fail = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("reports a 200 reply with an error and no data list, using the error text", async () => {
    const fetchFn = vi.fn(async () => fail({ error: "Unexpected endpoint" }));
    const groups = await listModels(global, {}, fetchFn as unknown as typeof fetch, ready);
    expect(groups[1]).toEqual({ label: "LM Studio", models: [], error: "Unexpected endpoint" });
  });

  it("clips a long reply error to 100 characters", async () => {
    const fetchFn = vi.fn(async () => fail({ error: "x".repeat(300) }));
    const groups = await listModels(global, {}, fetchFn as unknown as typeof fetch, ready);
    expect(groups[1]!.error).toHaveLength(100);
  });

  it("says key rejected when a 401 answers a sent key", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    const groups = await listModels(global, { "api-groq": "k-fake" }, fetchFn as unknown as typeof fetch, ready);
    expect(groups[2]).toEqual({ label: "API: groq", models: [], error: "key rejected" });
  });

  it("says needs a key for a 403 with no key", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 403 }));
    const groups = await listModels(global, {}, fetchFn as unknown as typeof fetch, ready);
    expect(groups[2]).toEqual({ label: "API: groq", models: [], error: "needs a key" });
  });

  it("sends the lmstudio key to LM Studio and never returns it", async () => {
    const fetchFn = vi.fn(async () => list(["qwen"]));
    const groups = await listModels(global, { lmstudio: "lm-fake" }, fetchFn as unknown as typeof fetch, ready);
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    const lmInit = calls.find((c) => String(c[0]).startsWith("http://localhost"))![1];
    expect((lmInit.headers as Record<string, string>).Authorization).toBe("Bearer lm-fake");
    expect(JSON.stringify(groups)).not.toContain("lm-fake");
  });
});
