import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "@agentcity/safety";
import { hqStats } from "../src/stats.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
let home: string;
let db: Database.Database;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-stats-"));
  db = openDb(home);
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function act(ts: string, agent: string, type: string, payload: unknown, run: string | null, parent: string | null = null, usd = 0): void {
  db.prepare("INSERT INTO actions (ts, project_id, agent_id, type, payload_json, usd, run_id, parent_run_id) VALUES (?, 'site', ?, ?, ?, ?, ?, ?)")
    .run(ts, agent, type, JSON.stringify(payload), usd, run, parent);
}

describe("hqStats", () => {
  it("counts top runs, finished runs, spend, tools and approvals over 7 days, per agent and per day", () => {
    act("2026-10-20T10:00:00.000Z", "ada", "run.started", { goal: "old" }, "r0");
    act("2026-11-01T10:00:00.000Z", "ada", "run.started", { goal: "fix footer" }, "r1");
    act("2026-11-01T10:00:01.000Z", "ada", "model.call", {}, "r1", null, 0.25);
    act("2026-11-01T10:00:02.000Z", "ada", "tool.requested", { call: { name: "edit_file", args: { path: "footer.tsx" } } }, "r1");
    act("2026-11-01T10:00:03.000Z", "ada", "tool.result", { outcome: "ok", result: "edited sk-secret123" }, "r1");
    act("2026-11-01T10:00:04.000Z", "bob", "run.started", { goal: "help" }, "r2", "r1");
    act("2026-11-01T10:00:05.000Z", "ada", "run.stopped", { reason: "done", steps: 3 }, "r1");
    act("2026-10-31T09:00:00.000Z", "vic", "run.started", { goal: "logo" }, "r3");
    act("2026-10-31T09:01:00.000Z", "vic", "run.stopped", { reason: "max_steps", steps: 20 }, "r3");
    for (const status of ["approved", "approved", "denied", "pending"]) {
      db.prepare("INSERT INTO approvals (ts, project_id, agent_id, tool, args_json, tier, status) VALUES ('2026-11-01T10:00:00.000Z', 'site', 'ada', 't', '{}', 2, ?)").run(status);
    }

    const s = hqStats(db, ["sk-secret123"], NOW);
    expect(s.runs).toBe(2);
    expect(s.done).toBe(1);
    expect(s.usd).toBeCloseTo(0.25);
    expect(s.tools).toBe(1);
    expect(s.approvals).toEqual({ approved: 2, denied: 1, pending: 1 });
    expect(s.days).toHaveLength(7);
    expect(s.days.at(-1)).toEqual({ day: "2026-11-01", runs: 1, usd: 0.25 });
    expect(s.days.at(-2)!.runs).toBe(1);
    expect(s.perAgent.find((a) => a.agentId === "ada")).toEqual({ agentId: "ada", runs: 1, done: 1, usd: 0.25, tools: 1 });
    expect(s.perAgent.find((a) => a.agentId === "vic")).toMatchObject({ runs: 1, done: 0 });
    expect(s.activity[0]).toMatchObject({ agentId: "vic", kind: "stop", text: "stopped: max_steps, 20 steps" });
    const texts = s.activity.map((a) => a.text);
    expect(texts).toContain("edit_file footer.tsx");
    expect(texts.some((t) => t.includes("sk-secret123"))).toBe(false);
  });

  it("returns zeros on an empty log", () => {
    const s = hqStats(db, [], NOW);
    expect(s).toMatchObject({ runs: 0, done: 0, usd: 0, tools: 0, perAgent: [], activity: [] });
  });
});
