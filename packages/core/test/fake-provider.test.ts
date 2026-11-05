import { describe, expect, it } from "vitest";
import { FakeProvider, type ChatRequest, type ChatResponse } from "@agentcity/core";

const usage = { inputTokens: 1, outputTokens: 1 };
const resp = (text: string): ChatResponse => ({ text, toolCalls: [], usage });
const req = (model: string): ChatRequest => ({ model, messages: [], tools: [], maxTokens: 10 });

describe("FakeProvider", () => {
  it("returns scripted responses in order", async () => {
    const p = new FakeProvider([resp("a"), resp("b")]);
    expect((await p.chat(req("m"))).text).toBe("a");
    expect((await p.chat(req("m"))).text).toBe("b");
  });
  it("throws scripted errors", async () => {
    const p = new FakeProvider([new Error("boom")]);
    await expect(p.chat(req("m"))).rejects.toThrow("boom");
  });
  it("records requests", async () => {
    const p = new FakeProvider([resp("a"), resp("b")]);
    await p.chat(req("m"));
    await p.chat(req("n"));
    expect(p.requests.length).toBe(2);
    expect(p.requests[0].model).toBe("m");
  });
  it("throws when exhausted", async () => {
    const p = new FakeProvider([]);
    await expect(p.chat(req("m"))).rejects.toThrow("FakeProvider script exhausted");
  });
});
