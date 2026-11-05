import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AnyTool, ToolCall } from "@agentcity/core";
import {
  ActionLog, ApprovalQueue, Budget, Gate, RunTree, dayKey, defaultProjectConfig, openDb, saveProjectConfig, toolAllowed,
  type ApprovalStatus, type Connection, type ProjectConfig,
} from "../src/index.js";
import { tempHome } from "./helpers.js";

const dbs: Database.Database[] = [];
afterEach(() => { while (dbs.length) dbs.pop()!.close(); });

const tool = (name: string, tier: 0 | 1 | 2 | 3, estimateUsd?: (a: unknown) => number): AnyTool =>
  ({ name, description: name, tier, schema: z.any(), run: async () => "ok", ...(estimateUsd ? { estimateUsd } : {}) }) as unknown as AnyTool;
const call = (name: string, args: unknown = {}): ToolCall => ({ id: "c1", name, args }) as ToolCall;

type Role = "boss" | "manager" | "worker";
const roles: Record<string, Role> = { ada: "manager", bob: "worker", cy: "boss" };
const rank: Record<Role, number> = { boss: 0, manager: 1, worker: 2 };
// Spec: a role delegates only to a strictly lower role.
const canDelegate = (from: Role, to: Role): boolean => rank[to] > rank[from];
const limits = { maxDepth: 3, maxTreeUsd: 0.5, maxChildRuns: 10 };

function setup(
  over: Partial<ProjectConfig> = {},
  status: ApprovalStatus = "approved",
  agentId = "ada",
  extra: { depth?: number; tree?: RunTree; plotTaken?: (plot: number) => boolean; connections?: Connection[];
    now?: () => Date; prices?: Record<string, { inputPerMTok: number; outputPerMTok: number }> } = {},
) {
  const home = tempHome();
  const config: ProjectConfig = {
    ...defaultProjectConfig("demo"),
    agents: ["ada", "bob", "cy"],
    allowedTools: ["t0", "t1", "t2", "t3", "other"],
    ...over,
  };
  saveProjectConfig(home, config);
  const db = openDb(home);
  dbs.push(db);
  const log = new ActionLog(db, []);
  const budget = new Budget(db);
  const approvals = new ApprovalQueue(db);
  let asked = 0;
  const approver = { decide: async () => { asked++; return status; } };
  const tree = extra.tree ?? new RunTree(limits);
  const gate = new Gate({
    home, projectId: "demo", agentId, log, budget, approvals, approver,
    prices: { "claude-haiku-5-5": { inputPerMTok: 1, outputPerMTok: 2 }, ...extra.prices }, connections: extra.connections,
    ...(extra.now ? { now: extra.now } : {}),
    tree, depth: extra.depth ?? 0, runId: "r1", roleOf: (id) => roles[id], canDelegate,
    ...(extra.plotTaken ? { plotTaken: extra.plotTaken } : {}),
  });
  return { home, config, db, log, budget, approvals, gate, tree, asked: () => asked };
}

describe("Gate", () => {
  it("board tools pass the allowlist, so a project need not list them", async () => {
    const s = setup({ allowedTools: [] });
    for (const name of ["create_task", "update_task", "request_merge", "ask_player", "create_goal", "propose_plan"]) {
      expect(await s.gate.checkTool(call(name), tool(name, 0))).toEqual({ kind: "allow" });
    }
    expect(await s.gate.checkTool(call("write_file"), tool("write_file", 0))).toEqual({ kind: "deny", reason: "tool_not_allowed" });
  });

  it("config_invalid stops tool and model checks", async () => {
    const s = setup();
    const home = tempHome();
    const g = new Gate({ home, projectId: "demo", agentId: "ada", log: s.log, budget: s.budget, approvals: s.approvals, approver: { decide: async () => "approved" }, prices: {}, tree: new RunTree(limits), depth: 0, runId: "r1", roleOf: () => undefined, canDelegate: () => false });
    expect(await g.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "stop", reason: "config_invalid" });
    expect(await g.checkModelCall({ model: "claude-haiku-5-5", estimatedInputTokens: 1 })).toEqual({ kind: "stop", reason: "config_invalid" });
  });

  it("kill switch stops before the allowlist", async () => {
    const s = setup({ killSwitch: true, allowedTools: [] });
    expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "stop", reason: "killed" });
  });

  it("agent not in agents stops tool and model checks", async () => {
    const s = setup({}, "approved", "zed");
    expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "stop", reason: "agent_not_allowed" });
    expect(await s.gate.checkModelCall({ model: "claude-haiku-5-5", estimatedInputTokens: 1 })).toEqual({ kind: "stop", reason: "agent_not_allowed" });
  });

  it("read_file also allows list_files and search_files, and nothing else", () => {
    expect(toolAllowed(["read_file"], "list_files")).toBe(true);
    expect(toolAllowed(["read_file"], "search_files")).toBe(true);
    expect(toolAllowed(["read_file"], "write_file")).toBe(false);
    expect(toolAllowed(["write_file"], "list_files")).toBe(false);
  });

  it("tool not in allowedTools is denied", async () => {
    const s = setup();
    expect(await s.gate.checkTool(call("nope"), tool("nope", 0))).toEqual({ kind: "deny", reason: "tool_not_allowed" });
  });

  describe("budget caps", () => {
    const haiku = { model: "claude-haiku-5-5", estimatedInputTokens: 1 };
    const sub = { model: "claude-sub/haiku", estimatedInputTokens: 1 };
    const subOver = { allowedModels: ["claude-sub/*"] };
    const subPrices = { prices: { "claude-sub/haiku": { inputPerMTok: 0, outputPerMTok: 0 } } };
    const used = (s: ReturnType<typeof setup>, model: string, tokens: number) =>
      s.gate.recordUsage(model, { inputTokens: tokens, outputTokens: 0 });

    it("job cap stops at jobTokens", async () => {
      const s = setup({ budget: { jobTokens: 200000, dayUsd: 0 } });
      await used(s, "claude-haiku-5-5", 199999);
      expect(await s.gate.checkModelCall(haiku)).toEqual({ kind: "allow" });
      await used(s, "claude-haiku-5-5", 1);
      expect(s.tree.tokens).toBe(200000);
      expect(await s.gate.checkModelCall(haiku)).toEqual({ kind: "stop", reason: "budget_job" });
      expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "stop", reason: "budget_job" });
    });

    it("a new RunTree starts at 0", async () => {
      const s = setup({ budget: { jobTokens: 100, dayUsd: 0 } });
      await used(s, "claude-haiku-5-5", 100);
      expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "stop", reason: "budget_job" });
      const fresh = setup({ budget: { jobTokens: 100, dayUsd: 0 } });
      expect(fresh.tree.tokens).toBe(0);
      expect(await fresh.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "allow" });
    });

    it("day cap stops at dayUsd and the next day allows", async () => {
      let now = new Date(2026, 10, 4, 12);
      const s = setup({ budget: { jobTokens: 0, dayUsd: 1 } }, "approved", "ada", { now: () => now });
      s.budget.add("demo", "other", 1, 1, "2026-11-04");
      expect(await s.gate.checkModelCall(haiku)).toEqual({ kind: "stop", reason: "budget_day" });
      expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "stop", reason: "budget_day" });
      now = new Date(2026, 10, 5, 0, 1);
      expect(await s.gate.checkModelCall(haiku)).toEqual({ kind: "allow" });
      expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "allow" });
    });

    it("lmstudio models skip both caps", async () => {
      const s = setup({ budget: { jobTokens: 10, dayUsd: 0.5 } });
      s.budget.add("demo", "ada", 1, 5);
      await used(s, "lmstudio/qwen", 1000);
      expect(await s.gate.checkModelCall({ model: "lmstudio/qwen", estimatedInputTokens: 1 })).toEqual({ kind: "allow" });
      expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "allow" });
      expect(s.budget.day("demo", dayKey(new Date())).tokens).toBe(1001);
    });

    it("0 turns a cap off", async () => {
      const s = setup({ budget: { jobTokens: 0, dayUsd: 0 } });
      s.budget.add("demo", "ada", 1, 50);
      await used(s, "claude-haiku-5-5", 5_000_000);
      expect(await s.gate.checkModelCall(haiku)).toEqual({ kind: "allow" });
      expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "allow" });
    });

    it("claude-sub models skip both caps and still record their tokens", async () => {
      const s = setup({ budget: { jobTokens: 200000, dayUsd: 1 }, ...subOver }, "approved", "ada", subPrices);
      s.budget.add("demo", "ada", 1, 5);
      await used(s, "claude-sub/haiku", 500000);
      expect(await s.gate.checkModelCall(sub)).toEqual({ kind: "allow" });
      expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "allow" });
      expect(s.budget.day("demo", dayKey(new Date())).tokens).toBe(500001);
    });
  });

  it("tier 0 and tier 1 are allowed without the approver", async () => {
    const s = setup();
    expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "allow" });
    expect(await s.gate.checkTool(call("t1"), tool("t1", 1))).toEqual({ kind: "allow" });
    expect(s.asked()).toBe(0);
  });

  it("tier 2 asks the approver; approved allows, denied returns user_denied", async () => {
    const ok = setup({}, "approved");
    expect(await ok.gate.checkTool(call("t2"), tool("t2", 2))).toEqual({ kind: "allow" });
    expect(ok.asked()).toBe(1);
    const no = setup({}, "denied");
    expect(await no.gate.checkTool(call("t2"), tool("t2", 2))).toEqual({ kind: "deny", reason: "user_denied" });
  });

  it("tier 2 asks even when autoApprove is on", async () => {
    const s = setup({ autoApprove: { enabled: true, maxUsdPerAction: 5, maxUsdPerDay: 10 } });
    await s.gate.checkTool(call("t2"), tool("t2", 2, () => 1));
    expect(s.asked()).toBe(1);
  });

  const auto = { enabled: true, maxUsdPerAction: 5, maxUsdPerDay: 10 };

  it("tier 3 auto-approves within both limits", async () => {
    const s = setup({ autoApprove: auto });
    expect(await s.gate.checkTool(call("t3"), tool("t3", 3, () => 4))).toEqual({ kind: "allow" });
    expect(s.asked()).toBe(0);
    expect(s.approvals.autoTotalToday("demo")).toBe(4);
  });

  it("tier 3 asks when over the per-action limit", async () => {
    const s = setup({ autoApprove: auto });
    await s.gate.checkTool(call("t3"), tool("t3", 3, () => 6));
    expect(s.asked()).toBe(1);
  });

  it("tier 3 asks when the daily total would pass the limit", async () => {
    const s = setup({ autoApprove: auto });
    s.approvals.recordAuto({ projectId: "demo", agentId: "ada", tool: "t3", args: {}, tier: 3, estimatedUsd: 8 });
    await s.gate.checkTool(call("t3"), tool("t3", 3, () => 4));
    expect(s.asked()).toBe(1);
  });

  it("tier 3 without estimateUsd is denied with no_estimate", async () => {
    const s = setup({ autoApprove: auto });
    expect(await s.gate.checkTool(call("t3"), tool("t3", 3))).toEqual({ kind: "deny", reason: "no_estimate" });
    expect(s.asked()).toBe(0);
    const row = s.log.list("demo").find((r) => r.type === "gate.decision")!;
    expect(row.payload).toMatchObject({ rule: "no_estimate" });
  });

  it("model not allowed stops", async () => {
    const s = setup({ allowedModels: ["claude-haiku-5-5"] });
    expect(await s.gate.checkModelCall({ model: "claude-other", estimatedInputTokens: 1 })).toEqual({ kind: "stop", reason: "model_not_allowed" });
  });

  it("unknown hosted model price stops", async () => {
    const s = setup({ allowedModels: ["claude-mystery"] });
    expect(await s.gate.checkModelCall({ model: "claude-mystery", estimatedInputTokens: 1 })).toEqual({ kind: "stop", reason: "unknown_model_price" });
  });

  it("allows an api model priced by its connection", async () => {
    const connections = [{ name: "groq", baseUrl: "https://g/v1", price: { inputPerMTok: 1, outputPerMTok: 1 } }];
    const s = setup({ allowedModels: ["api/*"] }, "approved", "ada", { connections });
    expect(await s.gate.checkModelCall({ model: "api/groq/llama", estimatedInputTokens: 1 })).toEqual({ kind: "allow" });
    expect(await s.gate.checkModelCall({ model: "api/none/llama", estimatedInputTokens: 1 })).toEqual({ kind: "stop", reason: "unknown_model_price" });
  });

  it("lmstudio model is allowed at zero cost", async () => {
    const s = setup();
    expect(await s.gate.checkModelCall({ model: "lmstudio/qwen", estimatedInputTokens: 1 })).toEqual({ kind: "allow" });
    await s.gate.recordUsage("lmstudio/qwen", { inputTokens: 1000, outputTokens: 1000 });
    expect(s.budget.project("demo").usd).toBe(0);
  });

  it("recordUsage adds cost to budget", async () => {
    const s = setup();
    await s.gate.recordUsage("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 500_000 });
    expect(s.budget.project("demo")).toEqual({ tokens: 1_500_000, usd: 2 });
    expect(s.budget.agent("demo", "ada").usd).toBe(2);
    const row = s.log.list("demo").find((r) => r.type === "usage")!;
    expect(row.usd).toBe(2);
  });

  it("config change is seen on the next check", async () => {
    const s = setup();
    expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "allow" });
    saveProjectConfig(s.home, { ...s.config, killSwitch: true });
    expect(await s.gate.checkTool(call("t0"), tool("t0", 0))).toEqual({ kind: "stop", reason: "killed" });
  });

  it("every decision writes a gate.decision row", async () => {
    const s = setup();
    await s.gate.checkTool(call("t0"), tool("t0", 0));
    await s.gate.checkTool(call("nope"), tool("nope", 0));
    await s.gate.checkModelCall({ model: "claude-haiku-5-5", estimatedInputTokens: 1 });
    const rows = s.log.list("demo").filter((r) => r.type === "gate.decision");
    expect(rows.map((r) => r.payload)).toEqual([
      { check: "tool", name: "t0", decision: "allow", rule: "tier0" },
      { check: "tool", name: "nope", decision: "deny", reason: "tool_not_allowed", rule: "allowlist" },
      { check: "model", name: "claude-haiku-5-5", decision: "allow", rule: "allowlist" },
    ]);
  });

  describe("build plot_taken", () => {
    it("denies plot_taken and logs rule build, approver not asked", async () => {
      const s = setup({ allowedTools: ["build"] }, "approved", "ada", { plotTaken: () => true });
      const d = await s.gate.checkTool(call("build", { plot: 2 }), tool("build", 2));
      expect(d).toEqual({ kind: "deny", reason: "plot_taken" });
      expect(s.asked()).toBe(0);
      const row = s.log.list("demo")[0]!;
      expect(row.payload).toMatchObject({ name: "build", decision: "deny", rule: "build" });
    });

    it("asks the approver when the plot is free", async () => {
      const seen: number[] = [];
      const s = setup({ allowedTools: ["build"] }, "approved", "ada", { plotTaken: (n) => { seen.push(n); return false; } });
      const d = await s.gate.checkTool(call("build", { plot: "3" }), tool("build", 2));
      expect(d).toEqual({ kind: "allow" });
      expect(s.asked()).toBe(1);
      expect(seen).toEqual([3]);
    });
  });
});
