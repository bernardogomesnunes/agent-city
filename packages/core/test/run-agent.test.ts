import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runAgent, FakeProvider, MemorySink, builtInTools, readFileTool,
  type ChatResponse, type GateDecision, type ToolCall, type ToolContext, type ToolGate, type AnyTool, type RunAgentOptions,
} from "../src/index.js";

const allow: GateDecision = { kind: "allow" };
const u = { inputTokens: 10, outputTokens: 5 };
const reply = (text: string, toolCalls: ToolCall[] = []): ChatResponse => ({ text, toolCalls, usage: u });
const readCall = (id = "c1", args: unknown = { path: "a.txt" }): ToolCall => ({ id, name: "read_file", args });

function fakeGate(opts: { model?: GateDecision[]; tool?: GateDecision[] } = {}) {
  const log = { model: [] as unknown[], tool: [] as ToolCall[], usage: [] as unknown[] };
  const gate: ToolGate = {
    async checkModelCall(r) { log.model.push(r); return opts.model?.shift() ?? allow; },
    async recordUsage(m, usage) { log.usage.push([m, usage]); },
    async checkTool(call) { log.tool.push(call); return opts.tool?.shift() ?? allow; },
  };
  return { gate, log };
}

let root: string;
let ctx: ToolContext;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ac-run-"));
  ctx = { projectId: "p", agentId: "a", sandboxDir: path.join(root, "box"), outboxDir: path.join(root, "out") };
  await fs.mkdir(ctx.sandboxDir);
  await fs.mkdir(ctx.outboxDir);
  await fs.writeFile(path.join(ctx.sandboxDir, "a.txt"), "file content");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function setup(script: Array<ChatResponse | Error>, gateOpts?: Parameters<typeof fakeGate>[0], extra: Partial<RunAgentOptions> = {}) {
  const provider = new FakeProvider(script);
  const events = new MemorySink();
  const g = fakeGate(gateOpts);
  const runSpy = vi.fn(readFileTool.run);
  const spyTool: AnyTool = { ...readFileTool, run: runSpy };
  const opts: RunAgentOptions = {
    provider, model: "m", tools: [spyTool, ...builtInTools.filter((x) => x.name !== "read_file")], gate: g.gate, events, projectId: "p", agentId: "a",
    agentName: "Ada", agentVersion: 1, goal: "do it", toolContext: ctx, sleep: async () => {}, ...extra,
  };
  return { provider, events, log: g.log, runSpy, run: () => runAgent(opts) };
}

describe("runAgent", () => {
  it("puts history between the system prompt and the goal, starting on a player message", async () => {
    const history = [
      { role: "assistant" as const, content: "orphan answer" },
      { role: "user" as const, content: "build the menu" },
      { role: "assistant" as const, content: "menu built" },
    ];
    const s = setup([reply("done")], undefined, { history });
    await s.run();
    const sent = s.provider.requests[0]!.messages.map((m) => [m.role, m.content]);
    expect(sent.slice(1)).toEqual([["user", "build the menu"], ["assistant", "menu built"], ["user", "do it"]]);
  });

  it("drops the oldest history when it passes half the context window", async () => {
    const long = "x".repeat(4000);
    const history = Array.from({ length: 10 }, (_, i) => [
      { role: "user" as const, content: `q${i} ${long}` },
      { role: "assistant" as const, content: `a${i}` },
    ]).flat();
    const s = setup([reply("done")], undefined, { history, contextWindow: 8000 });
    await s.run();
    const sent = s.provider.requests[0]!.messages;
    expect(sent.length).toBeLessThan(22);
    expect(sent.at(-2)!.content).toBe("a9");
    expect(sent[1]!.role).toBe("user");
  });

  it("stops with done when the model makes no tool calls", async () => {
    const s = setup([reply("hi")]);
    expect(await s.run()).toMatchObject({ reason: "done", steps: 1 });
  });

  it("logs the first 1200 chars of a reply that has no tool call", async () => {
    const long = "a".repeat(1500);
    const s = setup([reply(long)]);
    await s.run();
    const result = s.events.events.find((e) => e.type === "model.result");
    expect(result).toMatchObject({ type: "model.result", toolCallCount: 0, preview: "a".repeat(1200) });
  });

  it("logs no preview when the reply has a tool call", async () => {
    const s = setup([reply("working", [readCall()]), reply("ok")]);
    await s.run();
    const results = s.events.events.filter((e) => e.type === "model.result");
    expect(results[0]).toMatchObject({ toolCallCount: 1 });
    expect(results[0]).not.toHaveProperty("preview");
  });

  it("runs an allowed tool and feeds the result back", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")]);
    const r = await s.run();
    expect(r.reason).toBe("done");
    const last = s.provider.requests[1].messages.at(-1);
    expect(last).toMatchObject({ role: "tool", toolCallId: "c1", content: "file content" });
  });

  it("returns denied:<reason> on deny and continues", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")], { tool: [{ kind: "deny", reason: "no" }] });
    const r = await s.run();
    expect(r.reason).toBe("done");
    expect(s.provider.requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: "denied: no" });
    expect(s.runSpy).not.toHaveBeenCalled();
  });

  it("stops on gate stop from checkTool", async () => {
    const s = setup([reply("", [readCall(), readCall("c2")])], { tool: [{ kind: "stop", reason: "budget" }] });
    const r = await s.run();
    expect(r.reason).toBe("budget");
    expect(s.log.tool).toHaveLength(1);
    expect(s.runSpy).not.toHaveBeenCalled();
  });

  it("unknown gate decision kind fails closed", async () => {
    const bad = { kind: "ask" } as unknown as GateDecision;
    const t = setup([reply("", [readCall()])], { tool: [bad] });
    expect((await t.run()).reason).toBe("invalid_gate_decision");
    expect(t.runSpy).not.toHaveBeenCalled();
    const m = setup([reply("hi")], { model: [{} as unknown as GateDecision] });
    expect((await m.run()).reason).toBe("invalid_gate_decision");
    expect(m.provider.requests).toHaveLength(0);
  });

  it("stops on gate stop from checkModelCall", async () => {
    const s = setup([reply("hi")], { model: [{ kind: "stop", reason: "killed" }] });
    const r = await s.run();
    expect(r.reason).toBe("killed");
    expect(s.provider.requests).toHaveLength(0);
    expect(s.runSpy).not.toHaveBeenCalled();
  });

  it("stops with max_steps", async () => {
    const s = setup([reply("", [readCall("c1")]), reply("", [readCall("c2")]), reply("", [readCall("c3")])], undefined, { maxSteps: 2 });
    expect(await s.run()).toMatchObject({ reason: "max_steps", steps: 2 });
    expect(s.provider.requests).toHaveLength(2);
  });

  it("retries provider errors twice then stops with provider_error", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const s = setup([new Error("a"), new Error("b"), new Error("c")], undefined, { sleep });
    expect((await s.run()).reason).toBe("provider_error");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 4000]);
  });

  it("recovers when a retry succeeds", async () => {
    const s = setup([new Error("a"), reply("hi")]);
    expect((await s.run()).reason).toBe("done");
  });

  it("unknown tool name returns an error result without a gate call", async () => {
    const s = setup([reply("", [{ id: "c1", name: "nope", args: {} }]), reply("ok")]);
    await s.run();
    expect(s.provider.requests[1].messages.at(-1)).toMatchObject({ content: "error: unknown tool nope" });
    expect(s.log.tool).toHaveLength(0);
  });

  it("malformed args return invalid arguments without a gate call", async () => {
    const s = setup([reply("", [readCall("c1", { path: 5 })]), reply("ok")]);
    await s.run();
    const last = s.provider.requests[1].messages.at(-1);
    expect(last && "content" in last && last.content).toMatch(/^error: invalid arguments: /);
    expect(s.log.tool).toHaveLength(0);
  });

  it("tool exceptions become error results", async () => {
    const boom: AnyTool = { ...readFileTool, name: "boom", async run() { throw new Error("kaput"); } };
    const s = setup([reply("", [{ id: "c1", name: "boom", args: { path: "x" } }]), reply("ok")], undefined, { tools: [boom] });
    expect((await s.run()).reason).toBe("done");
    expect(s.provider.requests[1].messages.at(-1)).toMatchObject({ content: "error: kaput" });
  });

  it("parses text tool calls when toolCalls is empty", async () => {
    const text = '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
    const s = setup([reply(text), reply("ok")]);
    await s.run();
    expect(s.provider.requests[1].messages.at(-1)).toMatchObject({ role: "tool", name: "read_file", content: "file content" });
  });

  it("sums usage across steps", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")]);
    const r = await s.run();
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(s.log.usage).toHaveLength(2);
  });

  it("stops with interrupted when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const s = setup([reply("hi")], undefined, { signal: ac.signal });
    expect(await s.run()).toMatchObject({ reason: "interrupted", steps: 0 });
    expect(s.provider.requests).toHaveLength(0);
    expect(s.runSpy).not.toHaveBeenCalled();
  });

  it("passes the run signal into chat", async () => {
    const ac = new AbortController();
    const s = setup([reply("hi")], undefined, { signal: ac.signal });
    await s.run();
    expect(s.provider.requests[0]!.signal).toBe(ac.signal);
  });

  it("aborting during the first gate check ends interrupted and runs no tool", async () => {
    const ac = new AbortController();
    const secondRun = vi.fn(async () => "second");
    const second: AnyTool = { ...readFileTool, name: "second", run: secondRun };
    const firstRun = vi.fn(readFileTool.run);
    const spyTool: AnyTool = { ...readFileTool, run: firstRun };
    const provider = new FakeProvider([reply("", [readCall("c1"), { id: "c2", name: "second", args: { path: "x" } }]), reply("never")]);
    const gate: ToolGate = {
      async checkModelCall() { return allow; },
      async recordUsage() {},
      async checkTool() { ac.abort(); return allow; },
    };
    const r = await runAgent({
      provider, model: "m", tools: [spyTool, second], gate, events: new MemorySink(), projectId: "p", agentId: "a",
      agentName: "Ada", agentVersion: 1, goal: "do it", toolContext: ctx, sleep: async () => {}, signal: ac.signal,
    });
    expect(r.reason).toBe("interrupted");
    expect(firstRun).not.toHaveBeenCalled();
    expect(secondRun).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
  });

  it("emits run.started first and run.stopped last", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")]);
    await s.run();
    const types = s.events.events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types.at(-1)).toBe("run.stopped");
    expect(types).toContain("tool.requested");
    expect(types).toContain("tool.result");
  });
});

describe("runAgent endRun", () => {
  const finishTool = (run = vi.fn(async (_a: unknown, ctx: ToolContext) => { ctx.endRun?.(); return "posted"; })): AnyTool => ({
    ...readFileTool, name: "finish", run,
  });

  it("stops with done after a tool calls endRun, with no further model call", async () => {
    const tool = finishTool();
    const s = setup([reply("", [{ id: "c1", name: "finish", args: { path: "a.txt" } }]), reply("never")], undefined, { tools: [tool] });
    expect(await s.run()).toMatchObject({ reason: "done", steps: 1 });
    expect(s.provider.requests).toHaveLength(1);
    expect(s.events.events.at(-1)).toMatchObject({ type: "run.stopped", reason: "done" });
  });

  it("skips the calls after the one that ended the run", async () => {
    const tool = finishTool();
    const readRun = vi.fn(readFileTool.run);
    const s = setup(
      [reply("", [{ id: "c1", name: "finish", args: { path: "a.txt" } }, readCall("c2")]), reply("never")],
      undefined,
      { tools: [tool, { ...readFileTool, run: readRun }] },
    );
    await s.run();
    expect(tool.run).toHaveBeenCalledOnce();
    expect(readRun).not.toHaveBeenCalled();
  });

  it("does not stop a run when no tool calls endRun", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")]);
    expect(await s.run()).toMatchObject({ reason: "done", steps: 2 });
    expect(s.provider.requests).toHaveLength(2);
  });
});

describe("runAgent run ids, answer, detail", () => {
  it("result carries runId given by caller", async () => {
    const s = setup([reply("hi")], undefined, { runId: "r1" });
    expect((await s.run()).runId).toBe("r1");
  });

  it("runId defaults to 12 hex chars", async () => {
    const s = setup([reply("hi")]);
    expect((await s.run()).runId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("every event carries runId and parentRunId", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")], undefined, { runId: "r1", parentRunId: "p1" });
    await s.run();
    expect(s.events.events.length).toBeGreaterThan(3);
    for (const e of s.events.events) expect(e).toMatchObject({ runId: "r1", parentRunId: "p1" });
  });

  it("answer is the final text on done", async () => {
    const s = setup([reply("", [readCall()]), reply("the answer")]);
    expect((await s.run()).answer).toBe("the answer");
  });

  it("answer is the last non-empty text on max_steps", async () => {
    const s = setup([reply("first", [readCall("c1")]), reply("", [readCall("c2")]), reply("never")], undefined, { maxSteps: 2 });
    const r = await s.run();
    expect(r.reason).toBe("max_steps");
    expect(r.answer).toBe("first");
  });

  it("provider_error result and run.stopped carry detail with the error message", async () => {
    const s = setup([new Error("a"), new Error("b"), new Error("boom")]);
    const r = await s.run();
    expect(r).toMatchObject({ reason: "provider_error", detail: "boom", answer: "" });
    expect(s.events.events.at(-1)).toMatchObject({ type: "run.stopped", detail: "boom" });
  });

  it("tool receives toolContext.runId equal to the run id", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")], undefined, { runId: "r1" });
    await s.run();
    expect(s.runSpy.mock.calls[0][1]).toMatchObject({ runId: "r1" });
  });
});

describe("runAgent inbox", () => {
  it("appends a waiting message as the next user message after a tool batch", async () => {
    const waiting = ["stop and use blue"];
    const s = setup([reply("", [readCall()]), reply("ok")], undefined, { inbox: () => waiting.splice(0) });
    await s.run();
    const last = s.provider.requests[1]!.messages.at(-1)!;
    expect(last).toMatchObject({ role: "user", content: "Message from the player: stop and use blue" });
    expect(s.events.events).toContainEqual(expect.objectContaining({ type: "inbox", count: 1 }));
  });

  it("joins several waiting messages into one user message", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")], undefined, { inbox: () => ["a", "b"] });
    await s.run();
    const sent = s.provider.requests[1]!.messages;
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "Message from the player: a\n\nMessage from the player: b" });
    expect(sent.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("adds nothing and emits nothing when the inbox is empty", async () => {
    const s = setup([reply("", [readCall()]), reply("ok")], undefined, { inbox: () => [] });
    await s.run();
    expect(s.provider.requests[1]!.messages.at(-1)!.role).toBe("tool");
    expect(s.events.events.some((e) => e.type === "inbox")).toBe(false);
  });
});
