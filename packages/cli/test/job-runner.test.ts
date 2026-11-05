import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { FakeProvider, type AnyTool, type ChatRequest, type ChatResponse, type Provider } from "@agentcity/core";
import { makeProposePlanTool } from "@agentcity/org";
import { ActionLog, BoardStore, Budget, loadGlobalConfig, loadProjectConfig, openDb, saveProjectConfig } from "@agentcity/safety";
import { runCli } from "../src/wire.js";
import { BARE_CHAT_DAY_USD, BARE_CHAT_JOB_TOKENS, JobRunner, type Job } from "../src/job-runner.js";
import { WebApprovals } from "../src/web-approver.js";

const usage = { inputTokens: 1, outputTokens: 1 };
const call = (id: string, name: string, args: unknown): ChatResponse => ({ text: "", toolCalls: [{ id, name, args }], usage });
const say = (text: string): ChatResponse => ({ text, toolCalls: [], usage });

/** Answers every request with one read_file call, so a run only stops at its step cap. */
class Endless implements Provider {
  id = "endless";
  requests: ChatRequest[] = [];
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    return call(`c${this.requests.length}`, "read_file", { path: "missing.txt" });
  }
}

let home: string;
let cwd: string;
let db: ReturnType<typeof openDb>;
let approvals: WebApprovals;
let lines: string[];

const runner = (provider: Provider) =>
  new JobRunner({
    home, db, secrets: [], keys: { anthropic: "fake-test-key" }, global: loadGlobalConfig(home),
    providerOverride: provider, approvals, out: (l) => lines.push(l),
  });

const job = (kind: Job["kind"], over: Partial<Job> = {}): Job => ({
  kind, projectId: "demo", goalId: "g1", taskId: "t1", agentId: "ada", prompt: "do the task", cwd, ...over,
});

const allow = (...tools: string[]) => {
  const r = loadProjectConfig(home, "demo");
  if (!r.ok) throw new Error(r.error);
  r.config.allowedTools.push(...tools);
  saveProjectConfig(home, r.config);
};

/** Sets one project limit in the project config. */
const limit = (name: "stepsPerJob", value: number) => {
  const r = loadProjectConfig(home, "demo");
  if (!r.ok) throw new Error(r.error);
  r.config.limits[name] = value;
  saveProjectConfig(home, r.config);
};

const stopped = () =>
  new ActionLog(db, []).list("demo").filter((a) => a.type === "run.stopped").map((a) => a.payload as { reason: string; steps: number });

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-job-home-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ac-job-cwd-"));
  const io = { input: new PassThrough(), output: new PassThrough(), error: new PassThrough() };
  expect(await runCli(["init", "demo"], { home, io })).toBe(0);
  expect(await runCli(["agent", "create", "ada", "--name", "Ada", "--model", "lmstudio/test", "--persona", "You are Ada."], { home, io })).toBe(0);
  expect(await runCli(["grant", "demo", "ada"], { home, io })).toBe(0);
  db = openDb(home);
  approvals = new WebApprovals();
  lines = [];
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("JobRunner", () => {
  it("a work job's write_file lands in job.cwd", async () => {
    allow("write_file");
    const provider = new FakeProvider([call("1", "write_file", { path: "out/a.txt", content: "hello" }), say("done")]);
    const res = await runner(provider).run(job("work"), [], new AbortController().signal, () => []);
    expect(res.reason).toBe("done");
    expect(fs.readFileSync(path.join(cwd, "out", "a.txt"), "utf8")).toBe("hello");
  });

  it("a review job has no write or command tools in its tool specs", async () => {
    allow("read_file", "write_file", "edit_file", "delete_file", "run_command", "delegate", "report");
    const provider = new FakeProvider([say("ok")]);
    await runner(provider).run(job("review"), [], new AbortController().signal, () => []);
    const names = provider.requests[0]!.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    for (const t of ["write_file", "edit_file", "delete_file", "run_command", "delegate", "report"]) expect(names).not.toContain(t);
  });

  it("a plan or split job also has no write tools", async () => {
    allow("read_file", "write_file", "run_command");
    for (const kind of ["plan", "split"] as const) {
      const provider = new FakeProvider([say("ok")]);
      await runner(provider).run(job(kind), [], new AbortController().signal, () => []);
      const names = provider.requests[0]!.tools.map((t) => t.name);
      expect(names).toContain("read_file");
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("run_command");
    }
  });

  it("a work job gets a write tool and the board tools it is given", async () => {
    allow("write_file");
    const board: AnyTool = { name: "board_probe", description: "probe", tier: 0, schema: z.object({}), run: async () => "ok" };
    const provider = new FakeProvider([say("ok")]);
    await runner(provider).run(job("work"), [board], new AbortController().signal, () => []);
    const names = provider.requests[0]!.tools.map((t) => t.name);
    expect(names).toContain("write_file");
    expect(names).toContain("board_probe");
  });

  it("stepsPerJob stops a work job at its cap", async () => {
    allow("read_file");
    limit("stepsPerJob", 4);
    await runner(new Endless()).run(job("work"), [], new AbortController().signal, () => []);
    expect(stopped()).toEqual([{ reason: "max_steps", steps: 4 }]);
  });

  it("stepsPerJob stops a review job at the same cap", async () => {
    allow("read_file");
    limit("stepsPerJob", 3);
    await runner(new Endless()).run(job("review"), [], new AbortController().signal, () => []);
    expect(stopped()).toEqual([{ reason: "max_steps", steps: 3 }]);
  });

  it("stepsPerJob 0 has no step cap: a run past 30 steps still ends with its answer", async () => {
    allow("read_file");
    limit("stepsPerJob", 0);
    const calls = Array.from({ length: 31 }, (_, i) => call(`c${i}`, "read_file", { path: "missing.txt" }));
    const provider = new FakeProvider([...calls, say("done")]);
    const res = await runner(provider).run(job("work"), [], new AbortController().signal, () => []);
    expect(res.reason).toBe("done");
    expect(res.steps).toBeGreaterThan(30);
  });

  it("a project chat with stepsPerJob 0 still stops at 20 steps", async () => {
    allow("read_file");
    limit("stepsPerJob", 0);
    await runner(new Endless()).run(job("work", { tools: "chat" }), [], new AbortController().signal, () => []);
    expect(stopped()).toEqual([{ reason: "max_steps", steps: 20 }]);
  });

  it("a project chat uses stepsPerJob when it is above 0", async () => {
    allow("read_file");
    limit("stepsPerJob", 5);
    await runner(new Endless()).run(job("work", { tools: "chat" }), [], new AbortController().signal, () => []);
    expect(stopped()).toEqual([{ reason: "max_steps", steps: 5 }]);
  });

  it("logs run.started with the job's agent", async () => {
    const provider = new FakeProvider([say("ok")]);
    await runner(provider).run(job("work"), [], new AbortController().signal, () => []);
    const started = new ActionLog(db, []).list("demo").find((a) => a.type === "run.started");
    expect(started?.agentId).toBe("ada");
  });

  it("the system prompt carries the job rules for the agent's role", async () => {
    const provider = new FakeProvider([say("ok")]);
    await runner(provider).run(job("work"), [], new AbortController().signal, () => []);
    const sys = provider.requests[0]!.messages[0];
    expect(sys?.role === "system" && sys.content).toContain("Work only inside your worktree.");
  });

  it("uses the run id the job gives", async () => {
    const provider = new FakeProvider([say("ok")]);
    const res = await runner(provider).run(job("work", { runId: "fixed-run-1" }), [], new AbortController().signal, () => []);
    expect(res.runId).toBe("fixed-run-1");
    const started = new ActionLog(db, []).list("demo").find((a) => a.type === "run.started");
    expect(started?.runId).toBe("fixed-run-1");
  });

  it("a lead job's system prompt does not list tools the lead lacks", async () => {
    allow("read_file", "write_file", "run_command");
    const lead = new FakeProvider([say("ok")]);
    await runner(lead).run(job("review"), [], new AbortController().signal, () => []);
    const leadSys = lead.requests[0]!.messages[0];
    const leadText = leadSys?.role === "system" ? leadSys.content : "";
    expect(leadText).toContain("read_file");
    expect(leadText).not.toContain("write_file");
    expect(leadText).not.toContain("run_command");
    const work = new FakeProvider([say("ok")]);
    await runner(work).run(job("work"), [], new AbortController().signal, () => []);
    const workSys = work.requests[0]!.messages[0];
    expect(workSys?.role === "system" && workSys.content).toContain("write_file");
  });

  it("a plan job makes no model call after propose_plan posts the plan", async () => {
    const board = new BoardStore(db);
    const goalId = board.createGoal("demo", "make pong").id;
    const tool = makeProposePlanTool({
      board, goalId, agentId: "ada", role: "boss", allowedAssignees: [], onChange: () => undefined, onQuestion: () => undefined,
    });
    const provider = new FakeProvider([call("1", "propose_plan", { text: "Steps: one. Teams: none. Open questions: none." }), say("never")]);
    const res = await runner(provider).run(job("plan", { taskId: undefined }), [tool], new AbortController().signal, () => []);
    expect(res.reason).toBe("done");
    expect(provider.requests).toHaveLength(1);
    expect(board.goal(goalId)!.planState).toBe("proposed");
  });

  it("calls the inbox after a tool batch", async () => {
    allow("read_file");
    let calls = 0;
    const provider = new FakeProvider([call("1", "read_file", { path: "x.txt" }), say("ok")]);
    await runner(provider).run(job("work"), [], new AbortController().signal, () => (calls++, []));
    expect(calls).toBeGreaterThan(0);
  });

  it("an aborted job denies its own waiting approval and leaves another job's approval waiting", async () => {
    // A tier 2 tool always waits for the player.
    const risky: AnyTool = { name: "risky", description: "needs approval", tier: 2, schema: z.object({}), run: async () => "ran" };
    allow("risky");
    const asks = () => new FakeProvider([call("1", "risky", {}), say("ok")]);
    const a = new AbortController();
    const b = new AbortController();
    const first = runner(asks()).run(job("work"), [risky], a.signal, () => []);
    const second = runner(asks()).run(job("work", { taskId: "t2" }), [risky], b.signal, () => []);
    for (let i = 0; i < 200 && approvals.waiting().size < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(approvals.waiting().size).toBe(2);
    a.abort();
    await first;
    expect(approvals.waiting().size).toBe(1);
    b.abort();
    await second;
    expect(approvals.waiting().size).toBe(0);
  });

  describe("chat jobs", () => {
    const probe: AnyTool = { name: "create_goal", description: "probe", tier: 1, schema: z.object({ text: z.string() }), run: async (a) => `posted ${(a as { text: string }).text}` };
    const chat = (over: Partial<Job> = {}) => job("followup", { tools: "chat", goalId: "", taskId: undefined, ...over });

    it("with a project, only the read tools, remember and the extra tools are offered", async () => {
      allow("write_file", "edit_file", "delete_file", "run_command", "report");
      const provider = new FakeProvider([say("hi")]);
      await runner(provider).run(chat(), [probe], new AbortController().signal, () => []);
      const names = provider.requests[0]!.tools.map((t) => t.name).sort();
      expect(names).toEqual(["create_goal", "list_files", "read_file", "remember", "search_files"]);
    });

    it("the chat history reaches the model before the new message, and the chat rules are in the prompt", async () => {
      const provider = new FakeProvider([say("ok")]);
      const history = [{ role: "user" as const, content: "first" }, { role: "assistant" as const, content: "answer" }];
      await runner(provider).run(chat({ history, prompt: "second" }), [], new AbortController().signal, () => []);
      const msgs = provider.requests[0]!.messages;
      expect(msgs.slice(1).map((m) => [m.role, m.content])).toEqual([["user", "first"], ["assistant", "answer"], ["user", "second"]]);
      const sys = msgs[0];
      const text = sys?.role === "system" ? sys.content : "";
      expect(text).toContain("You are in a chat with the player.");
      expect(text).not.toContain("Work only inside your worktree.");
    });

    it("a project chat reads a file in its folder but write_file is refused by the tool set", async () => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "hello");
      const provider = new FakeProvider([call("1", "read_file", { path: "a.txt" }), call("2", "write_file", { path: "b.txt", content: "x" }), say("done")]);
      allow("write_file");
      await runner(provider).run(chat(), [], new AbortController().signal, () => []);
      expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false);
      const results = new ActionLog(db, []).list("demo").filter((a) => a.type === "tool.result").map((a) => (a.payload as { result: string }).result);
      expect(results[0]).toContain("hello");
    });

    it("a chat without a project offers remember and the extra tools, and runs them", async () => {
      const provider = new FakeProvider([call("1", "create_goal", { text: "make pong" }), say("posted")]);
      const res = await runner(provider).run(chat({ projectId: "" }), [probe], new AbortController().signal, () => []);
      expect(res.reason).toBe("done");
      expect(res.answer).toBe("posted");
      expect(provider.requests[0]!.tools.map((t) => t.name).sort()).toEqual(["create_goal", "remember"]);
      const results = new ActionLog(db, []).list("").filter((a) => a.type === "tool.result").map((a) => (a.payload as { result: string }).result);
      expect(results).toEqual(["posted make pong"]);
    });

    /** A paid agent: lmstudio and claude-sub models skip the caps, so the cap tests use an API model. */
    const subAgent = async (): Promise<void> => {
      const io = { input: new PassThrough(), output: new PassThrough(), error: new PassThrough() };
      expect(await runCli(["agent", "create", "bo", "--name", "Bo", "--model", "claude-haiku-5-5", "--persona", "You are Bo."], { home, io })).toBe(0);
    };

    it("a bare chat stops at 200000 tokens in one run, and the next run starts at 0", async () => {
      expect(BARE_CHAT_JOB_TOKENS).toBe(200_000);
      await subAgent();
      const big = { inputTokens: 100_000, outputTokens: 100_000 };
      const first = new FakeProvider([{ ...call("1", "read_file", { path: "x" }), usage: big }, say("never")]);
      const res = await runner(first).run(chat({ projectId: "", agentId: "bo" }), [], new AbortController().signal, () => []);
      expect(res.reason).toBe("budget_job");
      expect(first.requests).toHaveLength(1);
      const second = new FakeProvider([say("hi")]);
      const next = await runner(second).run(chat({ projectId: "", agentId: "bo" }), [], new AbortController().signal, () => []);
      expect(next.reason).toBe("done");
      expect(second.requests).toHaveLength(1);
    });

    it("a bare chat stops once the day's chats spent the dollar cap", async () => {
      await subAgent();
      new Budget(db).add("", "bo", 1, BARE_CHAT_DAY_USD);
      const provider = new FakeProvider([say("hi")]);
      const res = await runner(provider).run(chat({ projectId: "", agentId: "bo" }), [], new AbortController().signal, () => []);
      expect(res.reason).toBe("budget_day");
      expect(provider.requests).toHaveLength(0);
    });

    it("a bare chat on a local model skips both caps", async () => {
      new Budget(db).add("", "ada", 1, BARE_CHAT_DAY_USD);
      const big = { inputTokens: 100_000, outputTokens: 100_000 };
      const provider = new FakeProvider([{ ...call("1", "read_file", { path: "x" }), usage: big }, say("done")]);
      const res = await runner(provider).run(chat({ projectId: "" }), [], new AbortController().signal, () => []);
      expect(res.reason).toBe("done");
      expect(provider.requests).toHaveLength(2);
    });

    it("a bare chat on a claude-sub model skips both caps", async () => {
      const io = { input: new PassThrough(), output: new PassThrough(), error: new PassThrough() };
      expect(await runCli(["agent", "create", "cy", "--name", "Cy", "--model", "claude-sub/haiku", "--persona", "You are Cy."], { home, io })).toBe(0);
      new Budget(db).add("", "cy", 1, BARE_CHAT_DAY_USD);
      const big = { inputTokens: 100_000, outputTokens: 100_000 };
      const provider = new FakeProvider([{ ...call("1", "read_file", { path: "x" }), usage: big }, say("done")]);
      const res = await runner(provider).run(chat({ projectId: "", agentId: "cy" }), [], new AbortController().signal, () => []);
      expect(res.reason).toBe("done");
      expect(provider.requests).toHaveLength(2);
    });

    it("a chat without a project records its token use against the agent", async () => {
      await runner(new FakeProvider([say("hi")])).run(chat({ projectId: "" }), [], new AbortController().signal, () => []);
      expect(new Budget(db).agent("", "ada").tokens).toBe(2);
    });

    it("a chat without a project refuses a tool outside its set", async () => {
      const provider = new FakeProvider([call("1", "write_file", { path: "b.txt", content: "x" }), say("ok")]);
      await runner(provider).run(chat({ projectId: "" }), [], new AbortController().signal, () => []);
      expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false);
    });
  });
});
