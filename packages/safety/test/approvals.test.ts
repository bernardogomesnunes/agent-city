import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { ApprovalQueue, openDb } from "../src/index.js";
import type { ApprovalRequest, ApprovalStatus } from "../src/index.js";
import { tempHome } from "./helpers.js";

const dbs: Database.Database[] = [];
const open = () => { const d = openDb(tempHome()); dbs.push(d); return d; };
afterEach(() => { while (dbs.length) dbs.pop()!.close(); });

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  projectId: "p", agentId: "a", tool: "fs.write", args: { path: "x" }, tier: 2, estimatedUsd: 0.1, ...over,
});
const row = (db: Database.Database, id: number) =>
  db.prepare("SELECT status, decided_by, decided_at FROM approvals WHERE id = ?").get(id) as
    { status: string; decided_by: string | null; decided_at: string | null };

describe("ApprovalQueue", () => {
  it("approver receives args with secrets replaced by [secret]", async () => {
    const q = new ApprovalQueue(open(), ["sk-live-123"]);
    let seen: unknown;
    await q.request(req({ args: { header: "Bearer sk-live-123" } }), { decide: async (r) => { seen = r.args; return "approved"; } });
    expect(seen).toEqual({ header: "Bearer [secret]" });
  });

  it("approval args with a secret are stored as [secret]", async () => {
    const db = open();
    const q = new ApprovalQueue(db, ["sk-live-123"]);
    await q.request(req({ args: { header: "Bearer sk-live-123" } }), { decide: async () => "approved" });
    q.recordAuto(req({ args: { k: "sk-live-123" } }));
    const rows = db.prepare("SELECT args_json FROM approvals ORDER BY id").all() as Array<{ args_json: string }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.args_json).not.toContain("sk-live-123");
      expect(r.args_json).toContain("[secret]");
    }
  });

  it("approved decision is stored", async () => {
    const db = open();
    const q = new ApprovalQueue(db);
    const res = await q.request(req(), { decide: async () => "approved" });
    expect(res).toBe("approved");
    expect(row(db, 1)).toMatchObject({ status: "approved", decided_by: "user" });
    expect(row(db, 1).decided_at).not.toBeNull();
  });

  it("denied decision is stored", async () => {
    const db = open();
    const q = new ApprovalQueue(db);
    expect(await q.request(req(), { decide: async () => "denied" })).toBe("denied");
    expect(row(db, 1)).toMatchObject({ status: "denied", decided_by: "user" });
  });

  it("expireOrphans denies pending rows whose process ended, and rows from before owners were kept", async () => {
    const db = open();
    const live = new ApprovalQueue(db, [], undefined, 111);
    const dead = new ApprovalQueue(db, [], undefined, 222);
    const never = { decide: () => new Promise<ApprovalStatus>(() => undefined) };
    void live.request(req({ tool: "a" }), never);
    const gone = dead.request(req({ tool: "b" }), never);
    db.prepare("INSERT INTO approvals (ts, project_id, agent_id, tool, args_json, tier, status) VALUES ('t', 'p', 'a', 'old', 'null', 2, 'pending')").run();
    expect(live.expireOrphans((pid) => pid === 111)).toBe(2);
    expect(live.pendingAll().map((r) => r.tool)).toEqual(["a"]);
    expect(row(db, 2)).toMatchObject({ status: "denied", decided_by: "expired" });
    void gone;
  });

  it("row is pending while the approver waits", async () => {
    const db = open();
    const q = new ApprovalQueue(db);
    let resolve!: (s: ApprovalStatus) => void;
    const waiting = new Promise<ApprovalStatus>((r) => { resolve = r; });
    const p = q.request(req(), { decide: () => waiting });
    const pending = q.pending("p");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: 1, tool: "fs.write", args: { path: "x" }, tier: 2, estimatedUsd: 0.1 });
    resolve("approved");
    await p;
    expect(q.pending("p")).toHaveLength(0);
  });

  it("approver error becomes denied", async () => {
    const db = open();
    const q = new ApprovalQueue(db);
    const res = await q.request(req(), { decide: () => Promise.reject(new Error("boom")) });
    expect(res).toBe("denied");
    expect(row(db, 1)).toMatchObject({ status: "denied", decided_by: "error" });
  });

  it("denyAllPending marks waiting rows shutdown", async () => {
    const db = open();
    const q = new ApprovalQueue(db);
    void q.request(req(), { decide: () => new Promise<ApprovalStatus>(() => {}) });
    expect(q.denyAllPending()).toBe(1);
    expect(row(db, 1)).toMatchObject({ status: "denied", decided_by: "shutdown" });
    expect(q.denyAllPending()).toBe(0);
  });

  it("autoTotalToday sums only today's auto rows", () => {
    const db = open();
    let now = new Date(2026, 9, 29, 12, 0, 0);
    const q = new ApprovalQueue(db, [], () => now);
    q.recordAuto(req({ estimatedUsd: 2.0 }));
    now = new Date(2026, 9, 30, 9, 0, 0);
    q.recordAuto(req({ estimatedUsd: 1.0 }));
    now = new Date(2026, 9, 30, 15, 0, 0);
    q.recordAuto(req({ estimatedUsd: 0.5 }));
    q.recordAuto(req({ projectId: "other", estimatedUsd: 7 }));
    db.prepare(
      "INSERT INTO approvals (ts, project_id, agent_id, tool, args_json, tier, estimated_usd, status, decided_by) VALUES (?, 'p', 'a', 't', '{}', 2, 9.0, 'approved', 'user')",
    ).run(now.toISOString());
    expect(q.autoTotalToday("p")).toBe(1.5);
  });
});

describe("ApprovalQueue.pendingAll", () => {
  it("returns pending rows of 2 projects ordered by id, not decided ones", async () => {
    const db = open();
    const q = new ApprovalQueue(db);
    const hold: Array<(s: ApprovalStatus) => void> = [];
    const approver = { decide: () => new Promise<ApprovalStatus>((r) => { hold.push(r); }) };
    const p1 = q.request(req({ projectId: "p1" }), approver);
    const p2 = q.request(req({ projectId: "p2" }), approver);
    const p3 = q.request(req({ projectId: "p1", tool: "done" }), approver);
    hold[2]!("approved");
    await p3;
    const all = q.pendingAll();
    expect(all.map((r) => r.projectId)).toEqual(["p1", "p2"]);
    expect(all[0]!.id).toBeLessThan(all[1]!.id);
    hold[0]!("approved"); hold[1]!("denied");
    await Promise.all([p1, p2]);
    expect(q.pendingAll()).toEqual([]);
  });
});
