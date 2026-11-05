import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { openDb } from "../src/db.js";
import { SessionStore } from "../src/sessions.js";
import { tempHome } from "./helpers.js";

let home: string;
let db: BetterSqlite3.Database;
beforeEach(() => {
  home = tempHome();
  db = openDb(home);
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("firstUserId is the oldest player message of the chat, however long the chat is", () => {
    const s = new SessionStore(db);
    const a = s.create("game", "boss");
    const b = s.create("game", "boss");
    expect(s.firstUserId(a.id)).toBeUndefined();
    s.append(a.id, { kind: "system", author: "city", text: "hello" });
    const first = s.append(a.id, { kind: "user", author: "you", text: "one" });
    s.append(b.id, { kind: "user", author: "you", text: "other chat" });
    for (let i = 0; i < 300; i++) s.append(a.id, { kind: "agent", author: "boss", text: `row ${i}` });
    s.append(a.id, { kind: "user", author: "you", text: "two" });
    expect(s.firstUserId(a.id)).toBe(first.id);
  });

  it("open gives the newest chat of a pair and creates one when none exists", () => {
    const s = new SessionStore(db);
    const a = s.open("game", "boss");
    expect(s.open("game", "boss").id).toBe(a.id);
    expect(s.open("game", "ada").id).not.toBe(a.id);
    const b = s.create("game", "boss");
    expect(s.open("game", "boss").id).toBe(b.id);
    expect(s.list().map((x) => x.agentId)).toEqual(["boss", "ada", "boss"]);
  });

  it("create stores title and task", () => {
    const s = new SessionStore(db);
    const a = s.create("game", "boss", { title: "Fix broken index.html", taskId: "t1" });
    const got = s.get(a.id)!;
    expect(got.title).toBe("Fix broken index.html");
    expect(got.taskId).toBe("t1");
    expect(got.goalId).toBeUndefined();
    const g = s.create("game", "boss", { goalId: "g1" });
    expect(s.get(g.id)!.goalId).toBe("g1");
    expect(s.create("game", "boss").taskId).toBeUndefined();
  });

  it("two create calls for one pair give two sessions, and a chat can have no project", () => {
    const s = new SessionStore(db);
    const a = s.create("game", "boss");
    const b = s.create("game", "boss");
    expect(b.id).not.toBe(a.id);
    const none = s.create("", "boss");
    expect(none.projectId).toBe("");
    expect(s.forAgent("boss").map((x) => x.id)).toEqual([a.id, b.id, none.id]);
    expect(s.forAgent("ada")).toEqual([]);
  });

  it("title is the first player message cut to 40 characters and never changes", () => {
    const s = new SessionStore(db, ["sk-secret-123"]);
    const id = s.create("", "boss").id;
    expect(s.get(id)!.title).toBe("");
    s.append(id, { kind: "agent", author: "boss", text: "hello" });
    expect(s.get(id)!.title).toBe("");
    s.append(id, { kind: "user", author: "you", text: "x".repeat(100) });
    expect(s.get(id)!.title).toBe("x".repeat(40));
    s.append(id, { kind: "user", author: "you", text: "second" });
    expect(s.get(id)!.title).toBe("x".repeat(40));
    const k = s.create("", "boss").id;
    s.append(k, { kind: "user", author: "you", text: "key sk-secret-123" });
    expect(s.get(k)!.title).toBe("key [secret]");
  });

  it("redacts and caps text", () => {
    const s = new SessionStore(db, ["sk-secret-123"]);
    const id = s.open("game", "boss").id;
    expect(s.append(id, { kind: "user", author: "you", text: "key sk-secret-123" }).text).toBe("key [secret]");
    expect(s.append(id, { kind: "agent", author: "boss", text: "x".repeat(5000) }).text).toHaveLength(4000);
  });

  it("gives the oldest queued player message of the agent across its chats", () => {
    const s = new SessionStore(db);
    const a1 = s.create("game", "ada").id;
    const a2 = s.create("", "ada").id;
    const boss = s.create("game", "boss").id;
    const first = s.append(a2, { kind: "user", author: "you", text: "1", status: "queued" });
    s.append(a1, { kind: "user", author: "you", text: "2", status: "queued" });
    s.append(boss, { kind: "user", author: "you", text: "3", status: "queued" });
    expect(s.nextQueued("ada")!.id).toBe(first.id);
    s.setStatus(first.id, "running", "r1");
    expect(s.nextQueued("ada")!.text).toBe("2");
    expect(s.queuedAgents().sort()).toEqual(["ada", "boss"]);
  });

  it("closes messages left running by a crash with a system line", () => {
    const s = new SessionStore(db);
    const id = s.open("game", "boss").id;
    const m = s.append(id, { kind: "user", author: "you", text: "go", status: "running" });
    const lines = s.recover();
    expect(lines.map((l) => l.text)).toEqual(["stopped: city restarted"]);
    expect(s.message(m.id)!.status).toBe("done");
    expect(s.messages(id).map((x) => x.kind)).toEqual(["user", "system"]);
  });

  it("stores and clears a session branch", () => {
    const s = new SessionStore(db);
    const id = s.open("game", "ada").id;
    s.setBranch(id, "agent/ada-1");
    expect(s.get(id)!.branch).toBe("agent/ada-1");
    s.clearBranch("game", "agent/ada-1");
    expect(s.get(id)!.branch).toBeNull();
  });
});

describe("sessions migration", () => {
  const OLD = `
CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL, branch TEXT, UNIQUE (project_id, agent_id));
CREATE TABLE session_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id), ts TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('user','agent','report','system')), author TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','running','done')), run_id TEXT);
CREATE INDEX session_messages_by_session ON session_messages (session_id, id);
`;

  const oldHome = (): string => {
    const h = tempHome();
    const old = new Database(path.join(h, "agentcity.db"));
    old.exec(OLD);
    old.prepare("INSERT INTO sessions (id, project_id, agent_id, created_at, branch) VALUES (7, 'game', 'boss', '2026-01-01T00:00:00Z', 'agent/boss-1')").run();
    old.prepare("INSERT INTO sessions (id, project_id, agent_id, created_at, branch) VALUES (9, 'game', 'ada', '2026-01-02T00:00:00Z', NULL)").run();
    const m = old.prepare("INSERT INTO session_messages (session_id, ts, kind, author, text, status) VALUES (?, ?, ?, ?, ?, 'done')");
    m.run(7, "2026-01-01T00:00:01Z", "user", "you", "build the menu with a very long request that goes past forty characters");
    m.run(7, "2026-01-01T00:00:02Z", "agent", "boss", "done");
    old.close();
    return h;
  };

  it("keeps an old row's id, messages and branch and drops the unique pair", () => {
    const h = oldHome();
    try {
      const d = openDb(h);
      const s = new SessionStore(d);
      const got = s.get(7)!;
      expect([got.projectId, got.agentId, got.branch]).toEqual(["game", "boss", "agent/boss-1"]);
      expect(got.title).toBe("build the menu with a very long request ".slice(0, 40));
      expect(s.get(9)!.title).toBe("");
      expect(s.messages(7).map((x) => x.text)).toEqual(["build the menu with a very long request that goes past forty characters", "done"]);
      expect(s.create("game", "boss").id).toBeGreaterThan(9);
      expect(d.pragma("user_version", { simple: true })).toBe(1);
      expect(d.pragma("foreign_key_check")).toEqual([]);
      d.close();
      // a second open does not migrate again
      const again = openDb(h);
      expect(new SessionStore(again).list().map((x) => x.id)).toEqual([7, 9, 10]);
      again.close();
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });
});
