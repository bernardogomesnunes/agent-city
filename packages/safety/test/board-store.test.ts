import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { BoardError, BoardStore, GOAL_PLAN_MAX, type TaskStatus } from "../src/board-store.js";
import { tempHome } from "./helpers.js";

let home: string;
let db: Database.Database;
beforeEach(() => {
  home = tempHome();
  db = openDb(home);
});
afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Goal g1 with one team task t1 for boss. */
function setup(secrets: string[] = []) {
  const board = new BoardStore(db, secrets);
  const goal = board.createGoal("game", "make pong");
  const team = board.createTask({ goalId: goal.id, title: "pong team", description: "", createdBy: "boss" });
  return { board, goal, team };
}

/** A worker under the team, assigned to dev, moved to `status` with force. */
function worker(board: BoardStore, goalId: string, teamId: string, status: TaskStatus = "todo", deps: string[] = []) {
  const w = board.createTask({ goalId, parentId: teamId, title: "work", description: "", assignee: "dev", deps, createdBy: "manager" });
  if (status !== "todo") board.setStatus(w.id, status, { force: true });
  return board.task(w.id)!;
}

describe("BoardStore ids", () => {
  it("never reuses goal and task ids after a project delete", () => {
    const board = new BoardStore(db);
    const a1 = board.createGoal("aaa", "one");
    const a2 = board.createGoal("aaa", "two");
    const b1 = board.createGoal("bbb", "three");
    const ta = board.createTask({ goalId: a1.id, title: "x", description: "", createdBy: "boss" });
    const tb = board.createTask({ goalId: b1.id, title: "y", description: "", createdBy: "boss" });
    const tb2 = board.createTask({ goalId: b1.id, title: "z", description: "", createdBy: "boss" });
    const goneGoals = [a1.id, a2.id];
    const goneTasks = [ta.id];
    board.deleteProject("aaa");
    const g = board.createGoal("bbb", "four");
    const g2 = board.createGoal("bbb", "five");
    const t = board.createTask({ goalId: g.id, title: "n", description: "", createdBy: "boss" });
    const t2 = board.createTask({ goalId: g.id, title: "m", description: "", createdBy: "boss" });
    for (const id of [g.id, g2.id]) expect(goneGoals).not.toContain(id);
    for (const id of [t.id, t2.id]) expect(goneTasks).not.toContain(id);
    expect(new Set([b1.id, g.id, g2.id]).size).toBe(3);
    expect(new Set([tb.id, tb2.id, t.id, t2.id]).size).toBe(4);
  });

  it("an existing db without the counter opens and the next id is above the current max", () => {
    const board = new BoardStore(db);
    board.createGoal("aaa", "one");
    board.createGoal("aaa", "two");
    const goal = board.createGoal("aaa", "three");
    board.createTask({ goalId: goal.id, title: "x", description: "", createdBy: "boss" });
    db.exec("DROP TABLE id_counters");
    db.close();
    db = openDb(home);
    const again = new BoardStore(db);
    expect(again.createGoal("aaa", "four").id).toBe("g4");
    expect(again.createTask({ goalId: goal.id, title: "y", description: "", createdBy: "boss" }).id).toBe("t2");
  });
});

describe("BoardStore deleteProject", () => {
  it("deleteProject drops only that project", () => {
    const { board, goal, team } = setup();
    const w = worker(board, goal.id, team.id);
    board.addNote(w.id, "held", "hello");
    board.addRun(w.id, "run1", "work");
    board.setPaused("game", true);
    const other = board.createGoal("site", "other goal");
    const ot = board.createTask({ goalId: other.id, title: "site team", description: "", createdBy: "boss" });
    board.addNote(ot.id, "held", "keep");
    board.setPaused("site", true);
    board.deleteProject("game");
    expect(board.goals("game")).toEqual([]);
    expect(board.task(team.id)).toBeUndefined();
    expect(board.task(w.id)).toBeUndefined();
    expect(board.paused()).toEqual(["site"]);
    expect(board.goals("site").map((g) => g.id)).toEqual([other.id]);
    expect(board.task(ot.id)).toBeDefined();
    expect(board.notes(ot.id, "held")).toEqual(["keep"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_notes WHERE task_id = ?").get(w.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?").get(w.id)).toEqual({ n: 0 });
  });
});

const ALLOWED: Array<[TaskStatus, TaskStatus]> = [
  ["todo", "doing"], ["todo", "blocked"], ["todo", "cancelled"],
  ["doing", "review"], ["doing", "blocked"], ["doing", "todo"], ["doing", "cancelled"],
  ["review", "approval"], ["review", "doing"], ["review", "blocked"], ["review", "cancelled"],
  ["approval", "done"], ["approval", "doing"], ["approval", "cancelled"],
  ["blocked", "todo"], ["blocked", "cancelled"],
  ["done", "todo"], ["cancelled", "todo"],
];

describe("BoardStore ids and goals", () => {
  it("counts ids per database: g1, t1, t2", () => {
    const { board, goal, team } = setup();
    expect(goal.id).toBe("g1");
    expect(team.id).toBe("t1");
    const w = board.createTask({ goalId: goal.id, parentId: team.id, title: "w", description: "", createdBy: "manager" });
    expect(w.id).toBe("t2");
  });

  it("lists goals per project and changes goal status", () => {
    const { board } = setup();
    board.createGoal("site", "other");
    expect(board.goals("game").map((g) => g.id)).toEqual(["g1"]);
    expect(board.setGoalStatus("g1", "active").status).toBe("active");
    expect(board.goal("g1")!.status).toBe("active");
  });
});

describe("task moves", () => {
  it.each(ALLOWED)("allows %s -> %s", (from, to) => {
    const { board, goal, team } = setup();
    const w = worker(board, goal.id, team.id, from);
    expect(board.setStatus(w.id, to).status).toBe(to);
  });

  it.each([["todo", "done"], ["done", "doing"], ["approval", "review"]] as const)("refuses %s -> %s", (from, to) => {
    const { board, goal, team } = setup();
    const w = worker(board, goal.id, team.id, from);
    expect(() => board.setStatus(w.id, to)).toThrow(BoardError);
  });

  it("force allows a move the table forbids", () => {
    const { board, goal, team } = setup();
    const w = worker(board, goal.id, team.id, "todo");
    expect(board.setStatus(w.id, "done", { force: true }).status).toBe("done");
  });

  it("refuses doing without an assignee or with a dep not done", () => {
    const { board, goal, team } = setup();
    const a = board.createTask({ goalId: goal.id, parentId: team.id, title: "a", description: "", createdBy: "manager" });
    expect(() => board.setStatus(a.id, "doing")).toThrow(/assignee/);
    const b = worker(board, goal.id, team.id, "todo", [a.id]);
    expect(() => board.setStatus(b.id, "doing")).toThrow(/waits for t2/);
  });
});

describe("deps", () => {
  it("refuses an unknown dep", () => {
    const { board, goal, team } = setup();
    expect(() => board.createTask({ goalId: goal.id, parentId: team.id, title: "w", description: "", deps: ["t9"], createdBy: "manager" })).toThrow(/unknown dep t9/);
  });

  it("refuses a dep under another team", () => {
    const { board, goal, team } = setup();
    const w = worker(board, goal.id, team.id);
    const team2 = board.createTask({ goalId: goal.id, title: "team 2", description: "", createdBy: "boss" });
    expect(() => board.createTask({ goalId: goal.id, parentId: team2.id, title: "x", description: "", deps: [w.id], createdBy: "manager" })).toThrow(BoardError);
  });

  it("refuses a self dep and a cycle made by two updates", () => {
    const { board, goal, team } = setup();
    const t2 = worker(board, goal.id, team.id);
    const t3 = worker(board, goal.id, team.id);
    board.update(t2.id, { deps: [t3.id] });
    expect(() => board.update(t3.id, { deps: [t2.id] })).toThrow(/cycle/);
    expect(() => board.update(t2.id, { deps: [t2.id] })).toThrow(/self dep/);
    expect(board.task(t3.id)!.deps).toEqual([]);
  });

  it("holds a task back while its dep is not done", () => {
    const { board, goal, team } = setup();
    const t2 = worker(board, goal.id, team.id);
    const t3 = worker(board, goal.id, team.id, "todo", [t2.id]);
    expect(board.ready(goal.id).map((t) => t.id)).toEqual([t2.id]);
    board.setStatus(t2.id, "doing");
    expect(board.ready(goal.id).map((t) => t.id)).toEqual([]);
    board.setStatus(t2.id, "review");
    board.setStatus(t2.id, "approval");
    board.setStatus(t2.id, "done");
    expect(board.ready(goal.id).map((t) => t.id)).toEqual([t3.id]);
  });

  it("a worker waits for the deps of its team too", () => {
    const { board, goal, team } = setup();
    const second = board.createTask({ goalId: goal.id, title: "second team", description: "", createdBy: "boss", deps: [team.id] });
    const w = worker(board, goal.id, second.id);
    expect(board.ready(goal.id)).toEqual([]);
    board.setStatus(team.id, "done", { force: true });
    expect(board.ready(goal.id).map((t) => t.id)).toEqual([w.id]);
  });
});

describe("rollup", () => {
  it("a team task with a done and a cancelled child is done", () => {
    const { board, goal, team } = setup();
    worker(board, goal.id, team.id, "done");
    worker(board, goal.id, team.id, "cancelled");
    board.rollup(goal.id);
    expect(board.task(team.id)!.status).toBe("done");
  });

  it("a team task with one doing child is doing, and blocked when only blocked children remain", () => {
    const { board, goal, team } = setup();
    worker(board, goal.id, team.id, "doing");
    worker(board, goal.id, team.id, "done");
    board.rollup(goal.id);
    expect(board.task(team.id)!.status).toBe("doing");
    board.setStatus(board.children(team.id)[0].id, "blocked", { force: true });
    board.setStatus(board.children(team.id)[1].id, "blocked", { force: true });
    board.rollup(goal.id);
    expect(board.task(team.id)!.status).toBe("blocked");
  });

  it("a team task without children keeps its status", () => {
    const { board, goal, team } = setup();
    board.rollup(goal.id);
    expect(board.task(team.id)!.status).toBe("todo");
  });

  it("a goal is done when all team tasks are done and cancelled when all are cancelled", () => {
    const { board, goal, team } = setup();
    worker(board, goal.id, team.id, "done");
    board.rollup(goal.id);
    expect(board.goal(goal.id)!.status).toBe("done");

    const other = board.createGoal("game", "second");
    const t = board.createTask({ goalId: other.id, title: "team", description: "", createdBy: "boss" });
    worker(board, other.id, t.id, "cancelled");
    board.rollup(other.id);
    expect(board.goal(other.id)!.status).toBe("cancelled");
  });
});

describe("progress", () => {
  it("counts worker tasks only and skips cancelled ones", () => {
    const { board, goal, team } = setup();
    worker(board, goal.id, team.id, "done");
    worker(board, goal.id, team.id, "cancelled");
    worker(board, goal.id, team.id, "todo");
    expect(board.progress(goal.id)).toEqual({ done: 1, total: 2 });
  });
});

describe("text, counters and runs", () => {
  it("cuts a 3000-character description to 2000", () => {
    const { board, goal, team } = setup();
    const w = board.createTask({ goalId: goal.id, parentId: team.id, title: "w", description: "d".repeat(3000), createdBy: "manager" });
    expect(w.description).toHaveLength(2000);
  });

  it("stores a secret in a summary redacted", () => {
    const { board, goal, team } = setup(["sk-secret-123"]);
    const w = worker(board, goal.id, team.id);
    expect(board.update(w.id, { summary: "used sk-secret-123 for tests" }).summary).toBe("used [secret] for tests");
  });

  it("stores counters and the test output tail", () => {
    const { board, goal, team } = setup();
    const w = worker(board, goal.id, team.id);
    const t = board.update(w.id, { sendBacks: 1, nudges: 1, testFixes: 1, conflicts: 1, ci: "fail", testOutput: "x".repeat(5000) });
    expect([t.sendBacks, t.nudges, t.testFixes, t.conflicts, t.ci]).toEqual([1, 1, 1, 1, "fail"]);
    expect(t.testOutput).toHaveLength(4096);
  });

  it("records runs of a task in order", () => {
    const { board, team } = setup();
    board.addRun(team.id, "r1", "plan");
    board.addRun(team.id, "r2", "review");
    expect(board.runs(team.id)).toEqual([{ runId: "r1", kind: "plan" }, { runId: "r2", kind: "review" }]);
  });

  it("keeps answers and held messages across a restart; take empties held only", () => {
    const { board, team } = setup(["s3cret-value-1"]);
    board.addNote(team.id, "answer", "Which colour? Answer: blue");
    board.addNote(team.id, "held", "use s3cret-value-1");
    const again = new BoardStore(db, ["s3cret-value-1"]);
    expect(again.notes(team.id, "answer")).toEqual(["Which colour? Answer: blue"]);
    expect(again.takeNotes(team.id, "held")).toEqual(["use [secret]"]);
    expect(again.takeNotes(team.id, "held")).toEqual([]);
    expect(again.notes(team.id, "answer")).toHaveLength(1);
  });
});

describe("BoardStore.waitingTasks", () => {
  it("returns blocked, approval and failing tasks of every project", () => {
    const { board, goal, team } = setup();
    const site = board.createGoal("site", "site goal");
    const siteTeam = board.createTask({ goalId: site.id, title: "site team", description: "", createdBy: "boss" });
    worker(board, goal.id, team.id, "blocked"); // t3
    worker(board, goal.id, team.id, "approval"); // t4
    board.update(worker(board, goal.id, team.id, "doing").id, { ci: "fail" }); // t5
    board.update(worker(board, goal.id, team.id, "review").id, { ci: "pass" }); // t6, not waiting
    worker(board, goal.id, team.id, "todo"); // t7, not waiting
    worker(board, site.id, siteTeam.id, "blocked"); // t8, other project
    expect(board.waitingTasks().map((t) => t.id).sort()).toEqual(["t3", "t4", "t5", "t8"]);
  });
});

describe("goal plans and notes", () => {
  it("new goal has planState none and no plan", () => {
    const { board, goal } = setup();
    expect(board.createGoal("game", "second")).toMatchObject({ plan: null, planState: "none", planBy: null });
    expect(board.goal(goal.id)).toMatchObject({ plan: null, planState: "none", planBy: null });
  });

  it("proposePlan stores text, author and proposed", () => {
    const { board, goal } = setup();
    expect(board.proposePlan(goal.id, "boss", "step one")).toMatchObject({ plan: "step one", planState: "proposed", planBy: "boss" });
    expect(board.plansWaiting().map((g) => g.id)).toEqual([goal.id]);
    board.setPlanState(goal.id, "approved");
    expect(board.plansWaiting()).toEqual([]);
  });

  it("proposePlan refuses a goal that is not planning", () => {
    const { board, goal } = setup();
    board.setGoalStatus(goal.id, "active");
    expect(() => board.proposePlan(goal.id, "boss", "step one")).toThrow(BoardError);
  });

  it("proposePlan redacts and cuts at 4000", () => {
    const { board, goal } = setup(["sk-secret-123"]);
    expect(GOAL_PLAN_MAX).toBe(4000);
    const plan = board.proposePlan(goal.id, "boss", `sk-secret-123 ${"p".repeat(5000)}`).plan!;
    expect(plan).toHaveLength(4000);
    expect(plan.startsWith("[secret] ")).toBe(true);
  });

  it("takeGoalNotes keeps order", () => {
    const { board, goal } = setup();
    board.addGoalNote(goal.id, "first");
    board.addGoalNote(goal.id, "second");
    expect(board.takeGoalNotes(goal.id)).toEqual(["first", "second"]);
    expect(board.takeGoalNotes(goal.id)).toEqual([]);
  });

  it("old goals with tasks read as approved", () => {
    const old = tempHome();
    try {
      const raw = new Database(path.join(old, "agentcity.db"));
      raw.exec(`
        CREATE TABLE goals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, parent_id TEXT);
        INSERT INTO goals VALUES ('g1', 'game', 'with a task', 'planning', 't', 't'), ('g2', 'game', 'no task', 'planning', 't', 't');
        INSERT INTO tasks (id, goal_id, parent_id) VALUES ('t1', 'g1', NULL);
      `);
      raw.close();
      const upgraded = openDb(old);
      try {
        const board = new BoardStore(upgraded);
        expect(board.goal("g1")!.planState).toBe("approved");
        expect(board.goal("g2")!.planState).toBe("none");
      } finally {
        upgraded.close();
      }
    } finally {
      fs.rmSync(old, { recursive: true, force: true });
    }
  });
});

describe("pause, checkpoints and rollback notes", () => {
  it("setPaused writes and deletes a pause row, and paused lists the projects", () => {
    const { board } = setup();
    board.setPaused("b", true);
    board.setPaused("a", true);
    board.setPaused("a", true);
    expect(board.paused()).toEqual(["a", "b"]);
    board.setPaused("a", false);
    expect(board.paused()).toEqual(["b"]);
  });

  it("a task starts with no checkpoint and update stores one", () => {
    const { board, goal, team } = setup();
    const task = worker(board, goal.id, team.id);
    expect(task.checkpoint).toBeNull();
    expect(board.update(task.id, { checkpoint: "abc123" }).checkpoint).toBe("abc123");
  });

  it("an old tasks table gains the checkpoint column on open", () => {
    db.exec("ALTER TABLE tasks DROP COLUMN checkpoint");
    db.close();
    db = openDb(home);
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("checkpoint");
  });

  it("rollback notes are taken like held notes", () => {
    const { board, team } = setup();
    board.addNote(team.id, "rollback", "rolled back");
    expect(board.takeNotes(team.id, "rollback")).toEqual(["rolled back"]);
    expect(board.takeNotes(team.id, "rollback")).toEqual([]);
  });

  it("rebuilds an old task_notes table so rollback notes fit, keeping rows", () => {
    db.exec("DROP TABLE task_notes");
    db.exec("CREATE TABLE task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('answer','held')), text TEXT NOT NULL)");
    db.exec("INSERT INTO task_notes (task_id, kind, text) VALUES ('t1', 'answer', 'blue')");
    db.close();
    db = openDb(home);
    const board = new BoardStore(db);
    expect(board.notes("t1", "answer")).toEqual(["blue"]);
    board.addNote("t1", "rollback", "rolled back");
    expect(board.takeNotes("t1", "rollback")).toEqual(["rolled back"]);
  });
  it("setHeld persists and reloads", () => {
    const { board, goal, team } = setup();
    const task = worker(board, goal.id, team.id);
    expect(task.held).toBe(false);
    expect(board.setHeld(task.id, true).held).toBe(true);
    db.close();
    db = openDb(home);
    expect(new BoardStore(db).task(task.id)!.held).toBe(true);
    expect(new BoardStore(db).setHeld(task.id, false).held).toBe(false);
  });

  it("old db gains held", () => {
    const { board, goal, team } = setup();
    const task = worker(board, goal.id, team.id);
    db.exec("ALTER TABLE tasks DROP COLUMN held");
    db.close();
    db = openDb(home);
    expect(new BoardStore(db).task(task.id)!.held).toBe(false);
  });

  it("ready skips a held task", () => {
    const { board, goal, team } = setup();
    const task = worker(board, goal.id, team.id);
    board.setHeld(task.id, true);
    expect(board.ready(goal.id)).toEqual([]);
    board.setHeld(task.id, false);
    expect(board.ready(goal.id).map((t) => t.id)).toEqual([task.id]);
  });

  it("cuts a checkpoint longer than 64 characters to 64", () => {
    const { board, goal, team } = setup();
    const task = worker(board, goal.id, team.id);
    expect(board.update(task.id, { checkpoint: "c".repeat(100) }).checkpoint).toHaveLength(64);
  });
});
