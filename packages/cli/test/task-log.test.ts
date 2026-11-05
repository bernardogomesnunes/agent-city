import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActionLog, openDb, type ActionRow } from "@agentcity/safety";
import type { Task } from "@agentcity/safety";
import { resumeNote, taskContext, taskLog } from "../src/task-log.js";

let rowId = 0;
const row = (type: string, payload: unknown): ActionRow => ({
  id: ++rowId, ts: "", projectId: "game", agentId: "dev", type, payload, usd: 0, runId: "r1", parentRunId: null,
});
const req = (name: string, args: Record<string, unknown>) => row("tool.requested", { call: { name, args } });
const stopped = (reason: string) => row("run.stopped", { reason });

const homes: string[] = [];
const dbs: Array<ReturnType<typeof openDb>> = [];
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true });
});

const setup = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-tlog-"));
  homes.push(home);
  const db = openDb(home);
  dbs.push(db);
  return new ActionLog(db, []);
};

describe("taskLog", () => {
  it("turns the rows of the listed runs into log rows and skips model and gate rows", () => {
    const log = setup();
    const add = (runId: string, type: string, payload: unknown) => log.append({ projectId: "demo", agentId: "dev", runId, type, payload });
    add("r1", "run.started", { goal: "do it" });
    add("r1", "model.call", { model: "m" });
    add("r1", "gate.decision", { check: "tool" });
    add("r1", "tool.requested", { call: { name: "write_file", args: { path: "a.txt", content: "x" } } });
    add("r1", "tool.result", { callId: "1", name: "write_file", outcome: "ok", result: "wrote a.txt" });
    add("r1", "tool.result", { callId: "2", name: "run_command", outcome: "denied", result: "user_denied" });
    add("other", "tool.requested", { call: { name: "read_file", args: { path: "z" } } });
    add("r1", "run.stopped", { reason: "done", steps: 2 });
    add("r1", "run.stopped", { reason: "budget", steps: 3, detail: "over" });
    const rows = taskLog(log, ["r1"], (s) => s);
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["text", "started: do it"],
      ["tool", "write_file a.txt"],
      ["result", "write_file ok: wrote a.txt"],
      ["error", "run_command denied: user_denied"],
      ["text", "stopped: done, 2 steps"],
      ["error", "stopped: budget, 3 steps: over"],
    ]);
    expect(rows[0]!.agentId).toBe("dev");
  });

  it("redacts and cuts each text to 500 characters, and honours afterId", () => {
    const log = setup();
    log.append({ projectId: "demo", agentId: "dev", runId: "r1", type: "tool.result", payload: { name: "read_file", outcome: "ok", result: `sk-abc ${"y".repeat(900)}` } });
    const id = log.append({ projectId: "demo", agentId: "dev", runId: "r1", type: "tool.requested", payload: { call: { name: "list_files", args: {} } } });
    const rows = taskLog(log, ["r1"], (s) => s.replace("sk-abc", "[secret]"));
    expect(rows[0]!.text).toHaveLength(500);
    expect(rows[0]!.text).not.toContain("sk-abc");
    expect(rows[0]!.text.endsWith("...")).toBe(true);
    expect(taskLog(log, ["r1"], (s) => s, id - 1).map((r) => r.text)).toEqual(["list_files"]);
    expect(taskLog(log, [], (s) => s)).toEqual([]);
  });
});

describe("taskContext", () => {
  it("lists title, description, status, branch and the last 15 rows", () => {
    const task = { id: "t3", title: "Fix index", description: "the page is broken", status: "doing", branch: "agent/t3" } as Task;
    const rows = Array.from({ length: 20 }, (_, i) => ({ ts: "", agentId: "dev", kind: "tool" as const, text: `row${i}-${"x".repeat(200)}-SECRET` }));
    const out = taskContext(task, rows, (s) => s.replace("SECRET", "[redacted]"));
    const lines = out.split("\n");
    expect(lines[0]).toBe("This chat is about task t3: Fix index");
    expect(out).toContain("Description: the page is broken");
    expect(out).toContain("Status: doing");
    expect(out).toContain("Branch: agent/t3");
    const items = lines.filter((l) => l.startsWith("- "));
    expect(items).toHaveLength(15);
    expect(items[0]!.startsWith("- row5-")).toBe(true);
    expect(items[14]!.startsWith("- row19-")).toBe(true);
    for (const l of items) expect(l.length - 2).toBeLessThanOrEqual(120);
    expect(taskContext({ ...task, branch: null }, [], (s) => s)).toContain("Branch: none");
  });
});

describe("taskContext latest run", () => {
  const task = { id: "t3", title: "Fix", description: "d", status: "doing", branch: null } as Task;
  const log = (kind: "text" | "tool", text: string) => ({ ts: "", agentId: "dev", kind, text });

  it("lists the rows of the latest run only, up to 15", () => {
    const rows = [
      log("text", "started: first try"), log("tool", "old_a"), log("tool", "old_b"), log("text", "stopped: aborted, 2 steps"),
      log("text", "started: second try"), log("tool", "new_a"), log("tool", "new_b"),
    ];
    const items = taskContext(task, rows, (s) => s).split("\n").filter((l) => l.startsWith("- "));
    expect(items).toEqual(["- started: second try", "- new_a", "- new_b"]);
  });

  it("cuts the latest run to its last 15 rows", () => {
    const rows = [log("text", "started: old"), log("tool", "old_a"), log("text", "started: new"), ...Array.from({ length: 20 }, (_, i) => log("tool", `n${i}`))];
    const items = taskContext(task, rows, (s) => s).split("\n").filter((l) => l.startsWith("- "));
    expect(items).toHaveLength(15);
    expect(items[0]).toBe("- n5");
  });
});

describe("taskContext whitespace", () => {
  it("keeps the letter s and collapses whitespace runs", () => {
    const task = { id: "t3", title: "Fix", description: "d", status: "doing", branch: null } as Task;
    const rows = [{ ts: "", agentId: "dev", kind: "tool" as const, text: "read_file  src/index.ts\n  status" }];
    expect(taskContext(task, rows, (s) => s)).toContain("- read_file src/index.ts status");
  });
});

describe("resumeNote", () => {
  it("lists the tools of a stopped run", () => {
    const note = resumeNote([req("write_file", { path: "a.ts" }), req("run_command", { command: "npm test" }), stopped("aborted")], (s) => s);
    expect(note).toBe("Your last run on this task stopped (aborted). It did:\n- write_file a.ts\n- run_command npm test\nCheck the worktree before you redo anything.");
  });

  it("is undefined after a done run", () => {
    expect(resumeNote([req("write_file", { path: "a.ts" }), stopped("done")], (s) => s)).toBeUndefined();
  });

  it("says the city stopped when the run has no stop row", () => {
    expect(resumeNote([req("read_file", { path: "x" })], (s) => s)).toContain("stopped (the city stopped)");
  });

  it("keeps the last 15 tool rows, each cut to 120 characters and redacted", () => {
    const rows = Array.from({ length: 20 }, (_, i) => req("write_file", { path: `f${i}-${"x".repeat(200)}-SECRET` }));
    const lines = resumeNote(rows, (s) => s.replace("SECRET", "[redacted]"))!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(15);
    expect(lines[0]).toMatch(/^- write_file f5-/);
    expect(lines.every((l) => l.length <= 122)).toBe(true);
  });

  it("redacts a secret that sits in the first 100 characters of a tool arg", () => {
    const note = resumeNote([req("write_file", { path: "SECRET-a.ts" })], (s) => s.replace("SECRET", "[redacted]"))!;
    expect(note).toContain("- write_file [redacted]-a.ts");
    expect(note).not.toContain("SECRET");
  });
});
