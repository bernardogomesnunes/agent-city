# Delivery Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A goal either reaches its workers or tells the player in one Inbox card what stopped it and how to fix it.

**Architecture:** The scheduler checks for a team before it spends a model call. Rejected tool calls reach the blocked reason. Blocked tasks become Inbox cards. A blocked task that lost its team recovers by itself once a worker is granted.

**Tech Stack:** TypeScript, vitest, better-sqlite3, ws, jsdom.

**Spec:** None. The evidence below is the requirement.

## Evidence (scratch city database, 2026-11-05)

| Fact | Source |
|---|---|
| gamenew grants `boss` and `mgr` only, so it has 0 workers | `projects/gamenew/project.json` |
| Every `create_task` of the Manager answered `error: assignee must be one of ` with an empty list, in all 5 calls checked | `actions` rows 1196, 1360 to 1369 |
| t3 and t7 were blocked as "split created no tasks", which hides the cause | `tasks` table, `scheduler.ts:766` |
| t3 to t7 ran 13 split jobs and created 0 tasks | `task_runs` |
| Blocked tasks produce no Inbox card | `decisions.ts`, `inbox.ts` |
| Goal g2 stays `active` for ever, because `rollup` only sets done or cancelled | `board-store.ts:356` |
| t4 split ran while its dependency t3 was blocked | `scheduler.ts:508` |
| Steps stopped at once on 2026-11-03 by a lifetime token cap. Commit 235713f replaced that cap on 2026-11-04 | `actions` rows 1203, 1291 |
| Only 2 goals ever finished, both one-file docs with `ci = none` | `tasks` table |

The last row means tests, merges and dependency chains have never run end to end on real code. Task 6 exists for that reason.

## Global Constraints

- Branch `fix/delivery` off master. Commit each task on its own, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Keep each file's line endings.
- Never run the city against the real `~/.agentcity`. Never touch `C:\Users\berna\Documents\GitHub\GameNew`.
- A Windows vitest crash with exit 3221226505 is a known flake. Rerun once.
- Implementers and reviewers run on Haiku. A task still open after 2 fix rounds moves to Sonnet.

## Review Focus

1. A project with a Manager and 0 workers: no model call is made, and the card says which project needs a worker.
2. A worker granted while a task is blocked for no team: the task returns to todo on the next tick, with no click.
3. A worker in another building than the Manager: the Manager still gets that worker.
4. A task blocked for any other reason: it never restarts by itself.
5. A dependency unblocked by Retry: its dependents split on the next tick.

---

### Task 1: Check the team before splitting

**Files:**
- Modify: `packages/cli/src/scheduler.ts:508-515`, `:1047-1051`
- Test: `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Produces: `export const NO_TEAM = "no workers:"`, the prefix of the blocked reason. Task 4 consumes it.

- [ ] **Step 1: Write the failing tests.** `"a manager with no workers blocks the team task without a model call"`: project with boss and mgr, one todo team task, tick. Assert status `blocked`, `blockedReason` starts with `no workers:` and contains the project id, and 0 jobs ran. `"a manager gets the project's workers when none share its building"`: mgr in `software`, ada in `other`. Assert the split job's `create_task` accepts `ada`.
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/scheduler.test.ts`. Expected: both FAIL.
- [ ] **Step 3: Implement.** `teamOf` returns all project workers when the building filter leaves 0. In the split loop, when `lead` is a manager and `teamOf(config, lead)` is empty, call `this.block(team, "no workers: grant a worker to <project> in Configure")` and continue. The loop needs the project config; load it the way `tickProject` already does.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: a manager with no workers blocks before any model call`.

### Task 2: Say why a split created nothing

**Files:**
- Modify: `packages/org/src/board-tools.ts:13`, `:52-54`; `packages/cli/src/scheduler.ts:646-650`, `:761-769`
- Test: `packages/org/test/board-tools.test.ts` (or the file that covers `makeCreateTaskTool`), `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Produces: `BoardToolCtx.onRejected?: (text: string) => void`.

- [ ] **Step 1: Write the failing tests.** Empty `allowedAssignees` with an assignee given returns `error: this project has no workers; ask the player to grant one`. A split whose every `create_task` is rejected ends with `blockedReason` `split created no tasks: <that error>`.
- [ ] **Step 2: Run the two test files.** Expected: FAIL.
- [ ] **Step 3: Implement.** `create_task` calls `ctx.onRejected?.(text)` before it returns an error. The scheduler keeps the last text in a `Map<taskId, string>`, reads it in `afterSplit`, and deletes the entry.
- [ ] **Step 4: Run the two test files.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: blocked split reports the rejected call`.

### Task 3: Blocked tasks reach the Inbox

**Files:**
- Modify: `packages/cli/src/decisions.ts`, `packages/world/src/shared/protocol.ts`, `packages/client/src/ui/inbox.ts`
- Test: the decisions test in `packages/cli/test`, `packages/world` protocol test, `packages/client/test/inbox.test.ts`

**Interfaces:**
- Produces: decision kind `blocked` with `taskId`, `projectId`, `title`, `reason`.
- Consumes: the existing `task.action` messages `retry` and `cancel`.

- [ ] **Step 1: Write the failing tests.** `listDecisions` returns one `blocked` item per blocked task of an active goal, and none for cancelled goals. The protocol accepts the kind. The Inbox renders the title and reason with Retry and Cancel, the count includes it, and Retry sends `task.action` `retry`.
- [ ] **Step 2: Run the three test files.** Expected: FAIL.
- [ ] **Step 3: Implement,** following how the existing question kind is built and rendered.
- [ ] **Step 4: Run the three test files.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: blocked tasks show in the Inbox`.

### Task 4: Recover by itself after a grant

**Files:**
- Modify: `packages/cli/src/scheduler.ts` (`tickProject`)
- Test: `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `NO_TEAM` from Task 1.

- [ ] **Step 1: Write the failing tests.** `"granting a worker restarts a task blocked for no team"`: blocked with the `NO_TEAM` prefix, add ada to the config, tick. Assert the task left `blocked` and a split job started. `"a task blocked for another reason stays blocked"`: reason `merge conflict`, tick. Assert `blocked`.
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/scheduler.test.ts`. Expected: the first FAILS, the second passes.
- [ ] **Step 3: Implement.** At the start of the split loop, for each blocked team task with the prefix and a non-empty team, set status `todo` with `force` and clear `blockedReason`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: a task blocked for no team restarts after a grant`.

### Task 5: Stop spending on tasks that cannot run

**Files:**
- Modify: `packages/cli/src/scheduler.ts:508`, `packages/client/src/ui/projects-panel.ts`
- Test: `packages/cli/test/scheduler.test.ts`, `packages/client/test/projects-panel.test.ts`

- [ ] **Step 1: Write the failing tests.** A team task whose dependency is blocked starts no split job. After Retry on the dependency, it splits on the next tick. In level 2, a todo task with a blocked dependency reads `waiting on <dependency title>`.
- [ ] **Step 2: Run the two test files.** Expected: FAIL.
- [ ] **Step 3: Implement.** In the split loop, skip a team whose `deps` include a task with status `blocked`. In the Backlog row, show the text in place of the agent name. Check whether `TaskView` carries `deps`, and add it if missing.
- [ ] **Step 4: Run the two test files.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: tasks wait for a blocked dependency without spending`.

### Task 6: Prove one goal runs from start to merge

**Files:**
- Create: `packages/cli/test/delivery.test.ts`

- [ ] **Step 1: Write one test** with a scripted fake provider, the pattern `scheduler.test.ts` already uses, and a real temp git repo with a test command. Goal, 2 team tasks where the second depends on the first, split, work writes a file, tests run, review, approval, merge. Assert goal status `done`, both files on the base branch, and no blocked task.
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/delivery.test.ts`.
- [ ] **Step 3: If it passes, commit** `test: one goal runs from split to merge`. **If it fails, do not patch the scheduler.** Commit the test marked `it.fails`, and report the stage and the error to the controller. Each failure gets its own diagnosis.

### Task 7: Live trial on pong

Controller step, after the player approves the merge and the token spend.

- [ ] **Step 1:** `npm run build`, restart the preview city on the scratch home, resume pong.
- [ ] **Step 2:** Submit a small code goal: "Add a pause key (P) to the pong game".
- [ ] **Step 3:** Pass means the goal reaches `done` with its code on the base branch. Record tokens used and every stop.
