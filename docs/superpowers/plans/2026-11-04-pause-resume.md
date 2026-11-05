# Pause, resume and checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause and resume a project or the whole city, give a job that follows a stopped run a note of what that run did, and roll a task back to before its last run.

**Architecture:** The pause lives in a new `paused_projects` table in the board store, and the scheduler reads it on every tick and pump. A pure `resumeNote` in `task-log.ts` turns the last run's action rows into prompt text, and the scheduler gets those rows through a new dep. Checkpoints are a commit plus a `tasks.checkpoint` sha written before each worker job, and a `rollback` task action resets the worktree to it.

**Tech Stack:** TypeScript, vitest, better-sqlite3, zod, git CLI, plain DOM client.

**Spec:** `docs/superpowers/specs/2026-11-04-pause-resume-design.md`

## Global Constraints

- Copy exactly: "paused", "Pause", "Resume", "Stop all", "Resume all", "Roll back", "Undo the last run's changes?", "No project <id>", "stop the task first", "no checkpoint yet", "checkpoint is gone", "the city stopped".
- Checkpoint commit message: `<taskId>: checkpoint`.
- Resume note: last 15 `tool.requested` rows, each cut to 120 characters, redacted.
- Files are mostly CRLF. Keep each file's line endings.
- Run all tests with `npx vitest run <path>`. Lint with `npm run lint`.
- No subagent of this plan runs goals on a real project folder or the real `~/.agentcity`.

## Rulings against the spec

- Spec Part 1 says pause drops the project's queued items. A dropped followup loses its prompt (test failures, review notes, an answer). Ruling: queued items stay, and `pump` skips items of a paused project. The answer flow in the spec ("the job it would start waits for Resume") needs exactly this.
- The spec says the next job after a rollback gets no resume note. Ruling: rollback adds a task note of a new kind `"rollback"`. Building a worker prompt takes those notes, and a taken rollback note suppresses the resume note.

## Review Focus

1. Pause while a work job runs: the task slot must be released, or the project never starts another task after Resume. Task 4 tests a second task starting after resume.
2. Pause during a review job: the task goes to `approval` and stays there after Resume. Task 4 tests it.
3. Rollback of a task in `approval` (state table forbids approval to todo): needs `force`. Task 5 tests it.
4. A checkpoint commit must skip protected paths, like `toReview`. Task 5 passes `protectedPaths` and tests a protected file stays uncommitted.
5. An answer in a paused project must not start a job until Resume. Task 4 tests it.

---

### Task 1: Board store: pause rows, checkpoint column, rollback notes

**Files:**
- Modify: `packages/safety/src/db.ts` (schema and migration)
- Modify: `packages/safety/src/board-store.ts`
- Test: `packages/safety/test/board-store.test.ts`

**Interfaces:**
- Produces: `BoardStore.setPaused(projectId: string, paused: boolean): void`, `BoardStore.paused(): string[]` (sorted), `Task.checkpoint: string | null`, `TaskPatch` accepts `checkpoint`, `NoteKind = "answer" | "held" | "rollback"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("setPaused writes and deletes a pause row, and paused lists the projects", () => {
  board.setPaused("b", true);
  board.setPaused("a", true);
  board.setPaused("a", true);
  expect(board.paused()).toEqual(["a", "b"]);
  board.setPaused("a", false);
  expect(board.paused()).toEqual(["b"]);
});
it("a task starts with no checkpoint and update stores one", () => {
  // create goal and task as the file's other tests do
  expect(task.checkpoint).toBeNull();
  expect(board.update(task.id, { checkpoint: "abc123" }).checkpoint).toBe("abc123");
});
it("an old tasks table gains the checkpoint column on open", () => {
  // openDb(home); db.exec("ALTER TABLE tasks DROP COLUMN checkpoint"); db.close(); reopen with openDb(home)
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(cols).toContain("checkpoint");
});
it("rollback notes are taken like held notes", () => {
  board.addNote(task.id, "rollback", "rolled back");
  expect(board.takeNotes(task.id, "rollback")).toEqual(["rolled back"]);
  expect(board.takeNotes(task.id, "rollback")).toEqual([]);
});
```

- [ ] **Step 2: Run** `npx vitest run packages/safety/test/board-store.test.ts`. Expected: FAIL, `setPaused is not a function`.

- [ ] **Step 3: Implement**
  - `db.ts`: `CREATE TABLE IF NOT EXISTS paused_projects (project_id TEXT PRIMARY KEY, since TEXT NOT NULL)`. Add `checkpoint TEXT` to the `tasks` DDL, and an `ALTER TABLE tasks ADD COLUMN checkpoint TEXT` when `PRAGMA table_info(tasks)` lacks it, following the `plan_state` migration.
  - `board-store.ts`: `checkpoint` in `Task`, `TaskRow`, `toTask`, `TaskPatch` and `update`. `setPaused` uses `INSERT OR IGNORE` with `since = this.stamp()`, or `DELETE`. Check the note table's kind column has no CHECK that refuses `"rollback"`.

- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npx vitest run packages/safety` passes.

- [ ] **Step 5: Commit** `feat: board store keeps paused projects, task checkpoints and rollback notes`.

---

### Task 2: Git helpers for checkpoints

**Files:**
- Modify: `packages/cli/src/worktrees.ts`
- Test: `packages/cli/test/worktrees.test.ts`

**Interfaces:**
- Produces: `headSha(dir: string): string`, `commitExists(dir: string, sha: string): boolean`, `resetTo(dir: string, sha: string): void` (runs `git reset --hard <sha>` then `git clean -fd`).

- [ ] **Step 1: Write the failing tests**

```ts
it("resetTo returns a worktree to a commit and removes new untracked files", () => {
  // repo with a.txt committed; sha = headSha(repo)
  // change a.txt, add b.txt untracked, commit c.txt
  resetTo(repo, sha);
  expect(read("a.txt")).toBe(original);
  expect(exists("b.txt")).toBe(false);
  expect(exists("c.txt")).toBe(false);
  expect(headSha(repo)).toBe(sha);
});
it("commitExists is false for an unknown sha", () => {
  expect(commitExists(repo, headSha(repo))).toBe(true);
  expect(commitExists(repo, "0123456789abcdef0123456789abcdef01234567")).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/worktrees.test.ts`. Expected: FAIL, missing exports.
- [ ] **Step 3: Implement** with the existing `git()` helper. `commitExists` runs `git cat-file -e <sha>^{commit}` and returns false on a throw.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: git helpers for task checkpoints`.

---

### Task 3: Resume note text

**Files:**
- Modify: `packages/cli/src/task-log.ts`
- Modify: `packages/org/src/job-prompts.ts`
- Test: `packages/cli/test/task-log.test.ts`, `packages/org/test/job-prompts.test.ts`

**Interfaces:**
- Consumes: `ActionRow` from `@agentcity/safety`.
- Produces: `resumeNote(rows: ActionRow[], redactText: (s: string) => string): string | undefined` and `RESUME_ROWS = 15`, `RESUME_ROW_MAX = 120`. `workPrompt` options gain `resume?: string`, placed after the answers and inbox blocks.

- [ ] **Step 1: Write the failing tests**

```ts
it("resumeNote lists the tools of a stopped run", () => {
  const note = resumeNote([req("write_file", { path: "a.ts" }), req("run_command", { command: "npm test" }), stopped("aborted")], (s) => s);
  expect(note).toBe("Your last run on this task stopped (aborted). It did:\n- write_file a.ts\n- run_command npm test\nCheck the worktree before you redo anything.");
});
it("resumeNote is undefined after a done run", () => {
  expect(resumeNote([req("write_file", { path: "a.ts" }), stopped("done")], (s) => s)).toBeUndefined();
});
it("resumeNote says the city stopped when the run has no stop row", () => {
  expect(resumeNote([req("read_file", { path: "x" })], (s) => s)).toContain("stopped (the city stopped)");
});
it("resumeNote keeps the last 15 tool rows, each cut to 120 characters and redacted", () => {
  const rows = Array.from({ length: 20 }, (_, i) => req("write_file", { path: `f${i}-${"x".repeat(200)}-SECRET` }));
  const lines = resumeNote(rows, (s) => s.replace("SECRET", "[redacted]"))!.split("\n").filter((l) => l.startsWith("- "));
  expect(lines).toHaveLength(15);
  expect(lines[0]).toMatch(/^- write_file f5-/);
  expect(lines.every((l) => l.length <= 122)).toBe(true);
});
it("workPrompt adds the resume note", () => {
  expect(workPrompt(goal, task, [], { ...opts, resume: "NOTE" })).toContain("\nNOTE\n");
});
```

`req` and `stopped` build `ActionRow`s of type `tool.requested` (payload `{ call: { name, args } }`) and `run.stopped` (payload `{ reason }`).

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/task-log.test.ts packages/org/test/job-prompts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `rowOf` for the tool text. Redact first, then cut to 120 (the cut adds `...` inside the 120). Reason is the `run.stopped` payload reason when present, else `"the city stopped"`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: resume note from a stopped run`.

---

### Task 4: Scheduler pause and resume

**Files:**
- Modify: `packages/cli/src/scheduler.ts`
- Test: `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 `setPaused`, `paused`.
- Produces: `Scheduler.pause(projectId: string): { ok: true } | { ok: false; error: string }`, `Scheduler.resume(projectId: string)` (same return), `Scheduler.pauseAll(): void`, `Scheduler.resumeAll(): void`. Error for a project with no folder under `<home>/projects`: `No project <id>`. `Running.stop` gains `"pause"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("pause aborts the running work job, returns the task to todo with its worktree, and starts nothing until resume", async () => {
  // run to a work job whose script waits on c.signal; pause("demo")
  // until(() => status(t2) === "todo"); expect(board.task(t2)!.worktree).not.toBeNull()
  // await sched.tick(); expect no new job in fake.calls after the pause
  // sched.resume("demo"); until a second work job for t2 runs
});
it("after resume a second ready task can start, so pause released the slot", async () => {});
it("pause during a review job moves the task to approval", async () => {});
it("an answer in a paused project waits for resume", async () => {
  // task blocked by ask_player; pause; sched.answer(t, "yes"); await sched.tick();
  // expect(fake.kinds()).not.toContain("followup"); resume; until followup ran
});
it("a plan answer in a paused project starts no tasks job until resume", async () => {});
it("pauseAll and resumeAll pause and resume every project", () => {
  sched.pauseAll(); expect(board.paused()).toEqual(["demo"]);
  sched.resumeAll(); expect(board.paused()).toEqual([]);
});
it("a new scheduler on the same board keeps the pause", async () => {});
it("pause of an unknown project returns No project <id>", () => {
  expect(sched.pause("nope")).toEqual({ ok: false, error: "No project nope" });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/scheduler.test.ts -t "pause|resume"`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `pause`: write the row, set `stop = "pause"` and abort every running item of the project, call `changed`.
  - `after()`: when `run.stop === "pause"`, release the task's slot, then run a new private `recoverProject(projectId)` and return. `recover()` calls `recoverProject` for each project.
  - `tickProject` returns at once for a paused project. `pump` skips items of a paused project and leaves them queued.
  - `resume` deletes the row, calls `changed`, then `tick`.
- [ ] **Step 4: Run** `npx vitest run packages/cli/test/scheduler.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: scheduler pauses and resumes projects`.

---

### Task 5: Scheduler checkpoints, resume note and rollback

**Files:**
- Modify: `packages/cli/src/scheduler.ts`
- Test: `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 `checkpoint`, `"rollback"` notes; Task 2 `headSha`, `commitExists`, `resetTo`; Task 3 `resumeNote`, `workPrompt` `resume`.
- Produces: `SchedulerDeps.runRows?(runId: string): ActionRow[]`. `Scheduler.action(taskId, action: "retry" | "cancel" | "rollback"): { ok: true } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a work job stores a checkpoint after committing what the worktree had", async () => {
  // first work job writes a.txt and ends in doing with reason "aborted"; second work job starts
  // expect(board.task(t)!.checkpoint).toBe(sha of the commit "<t>: checkpoint" in the worktree)
});
it("a checkpoint commit leaves protected paths uncommitted", async () => {});
it("the work prompt after a stopped run carries the resume note", async () => {
  // deps.runRows returns a tool.requested row and no stop row
  // expect(fake.calls.at(-1)!.prompt).toContain("stopped (the city stopped)")
});
it("rollback resets the worktree to the checkpoint and sets the task to todo", async () => {
  // task blocked after a run that wrote b.txt; action(t, "rollback") -> ok
  // b.txt gone, status todo, blockedReason null, next work prompt has no "Your last run"
});
it("rollback of a task in approval sets it to todo", async () => {});
it("rollback errors", () => {
  // running task -> "stop the task first"; no checkpoint -> "no checkpoint yet";
  // checkpoint "0123...67" -> "checkpoint is gone"
});
```

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/scheduler.test.ts -t "checkpoint|rollback|resume note"`. Expected: FAIL.
- [ ] **Step 3: Implement** in `build()`, work mode, after `openWorktree`:
  - `commitAll(wt.path, "AgentCity checkpoint", \`${task.id}: checkpoint\`, config.protectedPaths)`, then `board.update(task.id, { checkpoint: headSha(wt.path) })`.
  - `const rolled = board.takeNotes(task.id, "rollback").length > 0`. Unless `rolled`, build the note from `this.d.runRows?.(board.runs(task.id).at(-1)?.runId)` with `resumeNote(rows, (s) => s)` (rows from `ActionLog` are already redacted with the stored secrets). Pass it as `resume` to `workPrompt`, or append it after `appendHeld` for a followup.
  - `rollback` in `action()`: "stop the task first" when a running or queued item has the task or the status is `doing` or `review`; "no checkpoint yet" when `checkpoint` or `worktree` is null; "checkpoint is gone" when `!commitExists`. Else `resetTo`, set status `todo` (with `force` from `approval`), clear `blockedReason`, add a `"rollback"` note, rollup, `changed`, `tick`. Retry and cancel return `{ ok: true }`.
- [ ] **Step 4: Run** `npx vitest run packages/cli/test/scheduler.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: checkpoints, resume note and rollback in the scheduler`.

---

### Task 6: Protocol and city server

**Files:**
- Modify: `packages/world/src/shared/protocol.ts`
- Modify: `packages/cli/src/city-server.ts`
- Test: `packages/cli/test/city-server.test.ts`

**Interfaces:**
- Consumes: Task 4 and 5 scheduler methods.
- Produces: ClientMsg `{ type: "project.pause"; projectId: string; paused: boolean }`, `{ type: "city.pause"; paused: boolean }`; `task.action` action enum adds `"rollback"`. ServerMsg `{ type: "paused"; projectIds: string[] }`. `TaskView.checkpoint: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
it("sends paused on connect", async () => { /* first messages include { type: "paused", projectIds: [] } */ });
it("project.pause pauses and broadcasts to every client", async () => {
  // two clients; send project.pause demo true; both get { type: "paused", projectIds: ["demo"] }
});
it("project.pause of an unknown project replies No project <id>", async () => {});
it("city.pause false resumes every project", async () => {});
it("task.action rollback with no checkpoint replies no checkpoint yet", async () => {});
```

- [ ] **Step 2: Run** `npx vitest run packages/cli/test/city-server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `runRows: (id) => actionLog.ofRuns([id])` to the Scheduler (move the `actionLog` line above it). `project.pause` and `city.pause` need no watch. A failed `scheduler.action` result is sent as `{ type: "error", message }`. Add `checkpoint` to `taskView`.
- [ ] **Step 4: Run** the same command, then `npx vitest run packages/world`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pause, stop all and rollback messages`.

---

### Task 7: Client buttons

**Files:**
- Modify: `packages/client/src/ui/board.ts`, `hud.ts`, `decisions.ts`, `index.ts`, `style.css`
- Test: `packages/client/test/board.test.ts`, `hud.test.ts`, `decisions.test.ts`

**Interfaces:**
- Consumes: Task 6 messages.
- Produces: `BoardView.setPaused(projectIds: string[]): void`, `Hud.setPaused(anyPaused: boolean): void`, `Hud.onStopAll(cb: (paused: boolean) => void): void`.

- [ ] **Step 1: Write the failing tests**

```ts
it("the project header shows Pause, and Resume with the paused tag after setPaused", () => {
  // click Pause -> sent { type: "project.pause", projectId: "demo", paused: true }
  // setPaused(["demo"]) -> button text "Resume", a tag with text "paused"
});
it("Stop all sends city.pause true and reads Resume all while a project is paused", () => {});
it("Roll back shows for a task with a checkpoint that is not doing or review, and asks first", () => {
  // click Roll back -> line "Undo the last run's changes?" and no send; click Yes ->
  // sent { type: "task.action", taskId, action: "rollback" }
});
it("a question decision has Roll back with the same confirm", () => {});
```

- [ ] **Step 2: Run** `npx vitest run packages/client/test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pause button and tag go in `BoardView.section()` next to the project title. Stop all sits in the HUD after the status text. Roll back sits in `board-actions` beside Retry and Cancel, hidden unless `t.checkpoint !== null` and the status is `todo`, `blocked` or `approval`. The confirm line has Yes and No buttons. `index.ts` routes `paused` to every board and the HUD.
- [ ] **Step 4: Run** `npx vitest run packages/client/test`, then `npm test` and `npm run lint`. Expected: all PASS, no lint warnings.
- [ ] **Step 5: Commit** `feat: pause, stop all and roll back buttons`.
