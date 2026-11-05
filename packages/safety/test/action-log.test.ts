import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { ActionLog, openDb } from "../src/index.js";
import { tempHome } from "./helpers.js";

const dbs: Database.Database[] = [];
const open = (home: string) => { const d = openDb(home); dbs.push(d); return d; };
afterEach(() => { while (dbs.length) dbs.pop()!.close(); });

describe("ActionLog", () => {
  it("append then list returns rows in order", () => {
    const log = new ActionLog(open(tempHome()), []);
    log.append({ projectId: "p", agentId: "a", type: "t1", payload: { n: 1 } });
    log.append({ projectId: "p", agentId: "a", type: "t2", payload: { n: 2 }, usd: 0.5 });
    const rows = log.list("p");
    expect(rows.map((r) => r.type)).toEqual(["t1", "t2"]);
    expect(rows[1]!.usd).toBe(0.5);
    expect(log.list("p", rows[0]!.id).map((r) => r.type)).toEqual(["t2"]);
  });

  it("rowsAfter and lastRows span projects in id order", () => {
    const log = new ActionLog(open(tempHome()), []);
    for (let i = 1; i <= 5; i++) log.append({ projectId: i % 2 ? "p" : "q", agentId: "a", type: `t${i}`, payload: {} });
    expect(log.lastRows(3).map((r) => r.type)).toEqual(["t3", "t4", "t5"]);
    expect(log.lastRows(99)).toHaveLength(5);
    const all = log.rowsAfter(0);
    expect(all).toHaveLength(5);
    expect(log.rowsAfter(all[1]!.id).map((r) => r.type)).toEqual(["t3", "t4", "t5"]);
    expect(log.rowsAfter(0, 2).map((r) => r.type)).toEqual(["t1", "t2"]);
  });

  it("ofRuns gives the rows of the listed runs after an id, in id order", () => {
    const log = new ActionLog(open(tempHome()), []);
    const add = (runId: string | undefined, type: string) => log.append({ projectId: "p", agentId: "a", type, payload: {}, runId });
    add("r1", "a1"); add("r2", "b1"); add(undefined, "x"); add("r1", "a2"); add("r3", "c1");
    expect(log.ofRuns(["r1", "r3"]).map((r) => r.type)).toEqual(["a1", "a2", "c1"]);
    const first = log.ofRuns(["r1"])[0]!;
    expect(log.ofRuns(["r1", "r2"], first.id).map((r) => r.type)).toEqual(["b1", "a2"]);
    expect(log.ofRuns([])).toEqual([]);
  });

  it("UPDATE throws append-only", () => {
    const db = open(tempHome());
    new ActionLog(db, []).append({ projectId: "p", agentId: "a", type: "t", payload: {} });
    expect(() => db.prepare("UPDATE actions SET type='x'").run()).toThrow(/append-only/);
  });

  it("DELETE throws append-only", () => {
    const db = open(tempHome());
    new ActionLog(db, []).append({ projectId: "p", agentId: "a", type: "t", payload: {} });
    expect(() => db.prepare("DELETE FROM actions").run()).toThrow(/append-only/);
  });

  it("redacts a secret inside nested payload", () => {
    const log = new ActionLog(open(tempHome()), ["sk-test-12345678"]);
    log.append({ projectId: "p", agentId: "a", type: "t", payload: { a: ["x sk-test-12345678 y"] } });
    expect(log.list("p")[0]!.payload).toEqual({ a: ["x [secret] y"] });
  });

  it("sink appends events with their type", () => {
    const log = new ActionLog(open(tempHome()), []);
    log.sink().emit({ type: "run.started", ts: "2026-01-01T00:00:00.000Z", projectId: "p", agentId: "a", runId: "r1", goal: "g", model: "m", agentName: "n", agentVersion: 1 });
    const [row] = log.list("p");
    expect(row).toMatchObject({ type: "run.started", ts: "2026-01-01T00:00:00.000Z", agentId: "a", payload: { goal: "g", model: "m", agentName: "n", agentVersion: 1 } });
  });

  it("append stores runId and parentRunId", () => {
    const log = new ActionLog(open(tempHome()), []);
    log.append({ projectId: "p", agentId: "a", type: "t", payload: {}, runId: "r1", parentRunId: "r0" });
    log.append({ projectId: "p", agentId: "a", type: "t", payload: {} });
    const rows = log.list("p");
    expect(rows[0]).toMatchObject({ runId: "r1", parentRunId: "r0" });
    expect(rows[1]).toMatchObject({ runId: null, parentRunId: null });
  });

  it("sink puts runId in columns and not in payload", () => {
    const log = new ActionLog(open(tempHome()), []);
    log.sink().emit({ type: "run.started", ts: "2026-01-01T00:00:00.000Z", projectId: "p", agentId: "a", runId: "r1", parentRunId: "r0", goal: "g", model: "m", agentName: "n", agentVersion: 1 });
    const [row] = log.list("p");
    expect(row).toMatchObject({ runId: "r1", parentRunId: "r0" });
    expect(row!.payload).not.toHaveProperty("runId");
    expect(row!.payload).not.toHaveProperty("parentRunId");
  });

  it("opening a part 1 db adds the columns and keeps old rows with null", () => {
    const home = tempHome();
    const old = new Database(path.join(home, "agentcity.db"));
    old.exec("CREATE TABLE actions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0)");
    old.prepare("INSERT INTO actions (ts, project_id, agent_id, type, payload_json) VALUES ('t', 'p', 'a', 'old', '{}')").run();
    old.close();
    const db = open(home);
    const log = new ActionLog(db, []);
    log.append({ projectId: "p", agentId: "a", type: "new", payload: {}, runId: "r1" });
    const rows = log.list("p");
    expect(rows[0]).toMatchObject({ type: "old", runId: null, parentRunId: null });
    expect(rows[1]).toMatchObject({ type: "new", runId: "r1" });
    expect(() => db.prepare("UPDATE actions SET type='x'").run()).toThrow(/append-only/);
  });

  it("two connections can write", () => {
    const home = tempHome();
    const l1 = new ActionLog(open(home), []);
    const l2 = new ActionLog(open(home), []);
    l1.append({ projectId: "p", agentId: "a", type: "t", payload: 1 });
    l2.append({ projectId: "p", agentId: "b", type: "t", payload: 2 });
    expect(l1.list("p")).toHaveLength(2);
  });
});
