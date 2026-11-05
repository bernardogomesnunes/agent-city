# Plan Approval and Job Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every goal waits for the player's Approve on a prose plan, and budgets cap each job's tokens and each project's daily dollars.

**Architecture:** Goals get `plan`, `plan_state` and `plan_by` columns plus a `goal_notes` table. The scheduler runs a `plan` job (tool `propose_plan`), waits for `plan.answer` from the J panel, then runs a `tasks` job with `create_task`. Budgets move from the lifetime `usage` table to a per-run token count in `RunTree` and a `usage_days` table.

**Tech Stack:** TypeScript, vitest (jsdom for client), zod, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-11-03-plan-approval-budgets-design.md`

## Global Constraints

- Plan text max 4000 characters, redacted like task notes. Goal note max 4000.
- `plan_state` values: `none`, `proposed`, `approved`.
- Decision id for a plan: `p:<goalId>`. Title: `Plan: <goal text>`.
- Job token cap default 200000. Daily dollar cap default 1. A cap of 0 means no cap.
- Models starting with `lmstudio/` skip both caps. Usage is still recorded.
- Stop reasons: `budget_job`, `budget_day`.
- Day key: local date `YYYY-MM-DD`.
- Blocked reason copy: `stopped: this job used its <N> tokens. Answer to continue with a new job.` and `stopped: the project spent its $<X> for today.` (N with thousands separators, e.g. 200,000).
- Files on disk are CRLF; edit with the Edit tool. Build with `npm run build` before running tests that cross packages.

## Review Focus

- A Request changes sent twice before the plan job reruns: both notes reach the next plan job, in order (Task 1 test `takeGoalNotes keeps order`).
- A server restart while a plan job runs (`plan_state = 'none'`, no tasks): the plan job runs again once, not twice (Task 3 test `recover reruns plan once`).
- `plan.answer` for a goal of a project the client does not watch: `plan.result` with ok false (Task 4 test).
- A config file with the old `budget: {maxTokens, maxUsd}` and `perAgent`: loads with defaults, and `project budget` saves only the new shape (Task 6 test).
- A job on `claude-sub/` with dayUsd 1: never stops on the day cap since cost is 0, stops on the job cap (Task 7 test).

---

### Task 1: Board store plan fields and goal notes

**Files:**
- Modify: `packages/safety/src/db.ts`, `packages/safety/src/board-store.ts`
- Test: `packages/safety/test/board-store.test.ts`

**Interfaces:**
- Produces:
  - `type PlanState = "none" | "proposed" | "approved"` (exported from `@agentcity/safety`).
  - `Goal` gains `plan: string | null`, `planState: PlanState`, `planBy: string | null`.
  - `BoardStore.proposePlan(goalId: string, agentId: string, text: string): Goal` sets plan (clipped to `GOAL_PLAN_MAX = 4000`), `plan_by`, state `proposed`. Throws `BoardError("goal <id> is not planning")` when goal status is not `planning`.
  - `BoardStore.setPlanState(goalId: string, state: PlanState): Goal`.
  - `BoardStore.addGoalNote(goalId: string, text: string): void`, `takeGoalNotes(goalId: string): string[]` (oldest first, deleted after read).
  - `BoardStore.plansWaiting(): Goal[]`: goals with status `planning` and `plan_state = 'proposed'`, every project.

- [ ] **Step 1: Write failing tests** in `board-store.test.ts`:
  - `new goal has planState none and no plan`: `createGoal` gives `{plan: null, planState: "none", planBy: null}`.
  - `proposePlan stores text, author and proposed`: then `plansWaiting()` lists it; after `setPlanState(id, "approved")` it is gone.
  - `proposePlan refuses a goal that is not planning`: after `setGoalStatus(id, "active")` it throws `BoardError`.
  - `proposePlan redacts and cuts at 4000`.
  - `takeGoalNotes keeps order`: two `addGoalNote` calls, take returns both in order, second take returns `[]`.
  - `old goals with tasks read as approved`: build a db with the old `goals` table (no plan columns), insert a goal with one task and one without, open with `openDb`; the first reads `approved`, the second `none`.
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/board-store.test.ts`. Expected: FAIL on missing `proposePlan`.
- [ ] **Step 3: Implement.** In `db.ts` add `CREATE TABLE IF NOT EXISTS goal_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, text TEXT NOT NULL)` and, when `goals` lacks `plan_state`, `ALTER TABLE goals ADD COLUMN plan TEXT`, `ADD COLUMN plan_state TEXT NOT NULL DEFAULT 'none'`, `ADD COLUMN plan_by TEXT`, then `UPDATE goals SET plan_state = 'approved' WHERE id IN (SELECT goal_id FROM tasks)`. Map the columns in `toGoal`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npx vitest run packages/safety` passes.
- [ ] **Step 5: Commit** `feat: goals keep a plan, its state and the player's notes`.

### Task 2: propose_plan tool and plan prompts

**Files:**
- Modify: `packages/org/src/board-tools.ts`, `packages/org/src/job-prompts.ts`, `packages/org/src/index.ts` (exports)
- Test: `packages/org/test/board-tools.test.ts`, `packages/org/test/job-prompts.test.ts`

**Interfaces:**
- Consumes: `BoardStore.proposePlan` (Task 1).
- Produces:
  - `makeProposePlanTool(ctx: BoardToolCtx): Tool<{ text: string }>`, name `propose_plan`, tier 0, schema text 1..4000. Returns `plan posted for <goalId>. End your turn; the player answers it.` or `error: <BoardError message>`. Calls `ctx.onChange()` on success.
  - `planPrompt(goal: Goal, members: Member[], previous: string | null, notes: string[]): string`. Asks for three plain-text parts headed `Steps`, `Teams`, `Open questions`, posted with `propose_plan`. With `previous`, includes it under `Your last plan:` and the notes under `The player asked for changes:`.
  - `tasksPrompt(goal: Goal, plan: string, board: Task[], members: Member[]): string`. Today's create_task instruction, with the approved plan under `The player approved this plan:`.
  - `JOB_RULES.boss` first line becomes `For a new goal, post a plan with propose_plan. After the player approves, create team tasks with create_task.` Other lines stay.
- Add `"propose_plan"` to `BOARD_TOOLS` in `packages/safety/src/gate.ts`.

- [ ] **Step 1: Write failing tests:**
  - `propose_plan stores the plan and calls onChange`; `propose_plan on an active goal returns error:`.
  - `planPrompt names propose_plan and the three parts`; `planPrompt with previous plan and notes includes both`.
  - `tasksPrompt includes the approved plan and create_task`.
  - `boss rules mention propose_plan`.
  - In `packages/safety/test/gate.test.ts`, the board tools loop list adds `propose_plan`.
- [ ] **Step 2: Run** `npx vitest run packages/org packages/safety/test/gate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the tool, prompts, rule line and BOARD_TOOLS entry.
- [ ] **Step 4: Run** `npm run build` then the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: the boss posts a prose plan with propose_plan`.

### Task 3: Scheduler waits for plan approval

**Files:**
- Modify: `packages/cli/src/scheduler.ts`, `packages/cli/src/job-runner.ts` (Job kind adds `"tasks"`, LEAD_KINDS adds it), `packages/safety/src/board-store.ts` (`RunKind` adds `"tasks"`)
- Test: `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 store methods, Task 2 `makeProposePlanTool`, `planPrompt`, `tasksPrompt`.
- Produces: `Scheduler.answerPlan(goalId: string, option: "approve" | "changes" | "reject", text?: string): { ok: true } | { ok: false; error: string }`.
  - Error `plan is not waiting` when the goal is missing, not `planning`, or not `proposed`.
  - Error `say what to change` for `changes` with empty or missing text.
  - approve: `setPlanState(approved)`, tick. changes: `addGoalNote`, `setPlanState(none)`, tick. reject: `setGoalStatus(cancelled)`.

Tick rules for a goal with status `planning` and no tasks (replaces the block at `scheduler.ts:293`):
- No boss: goal `failed` (as today).
- `none` and not in `this.planning`: enqueue `{kind: "plan", mode: "plan"}` for the boss.
- `proposed`: nothing.
- `approved`, no managers: today's single boss team task, goal `active`.
- `approved`, managers, not in `this.planning`: enqueue `{kind: "tasks", mode: "plan"}` with `prompt` unset; `build` picks the tool by `item.kind`.

`build` for mode `plan`: kind `plan` gets `makeProposePlanTool` and `planPrompt(goal, managers, goal.plan, board.takeGoalNotes(goal.id))`; kind `tasks` gets `makeCreateTaskTool` (as today) and `tasksPrompt`.

`afterPlan`: kind `plan` sets goal `failed` when `planState` is still `none` after the job. Kind `tasks` keeps today's rule (no team tasks: `failed` on hard stop, else `failed`; teams: `active`).

- [ ] **Step 1: Write failing tests** with the existing FakeProvider helpers:
  - `a new goal runs a plan job and waits at proposed`: provider calls `propose_plan`; after idle, `fake.kinds()` is `["plan"]`, goal `planning`, `planState` `proposed`, no tasks.
  - `approve runs tasks then split`: `answerPlan(g, "approve")`; kinds become `["plan", "tasks", "split", ...]`, and the tasks job prompt contains the plan text.
  - `changes reruns plan with the note`: second plan job's prompt contains the note and the old plan.
  - `changes without text is refused`: returns `{ok: false, error: "say what to change"}`.
  - `reject cancels the goal`.
  - `answerPlan on a goal that is not proposed is refused`.
  - `a plan job without propose_plan fails the goal`.
  - `approve with no managers makes one boss team task`.
  - `recover reruns plan once`: goal at `none` with no tasks, `recover()` then two ticks; one plan job.
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/scheduler.test.ts`. Expected: new tests FAIL. Old tests that expect `["plan", "split", ...]` also fail; update them to approve the plan in the test (helper `approveAll()` calling `answerPlan` for each `plansWaiting()` goal).
- [ ] **Step 3: Implement** per the rules above.
- [ ] **Step 4: Run** `npm run build` and `npx vitest run packages/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: goals wait for the player's plan approval before any task`.

### Task 4: Plan decisions over the wire

**Files:**
- Modify: `packages/world/src/shared/protocol.ts`, `packages/cli/src/decisions.ts`, `packages/cli/src/city-server.ts`
- Test: `packages/cli/test/decisions.test.ts`, `packages/cli/test/city-server.test.ts`, `packages/world/test/protocol.test.ts` (if present)

**Interfaces:**
- Consumes: `BoardStore.plansWaiting()`, `Scheduler.answerPlan`.
- Produces:
  - `DecisionViewSchema.kind` adds `"plan"`; new optional field `goalId: string`.
  - `DecisionInput` gains `goals: Goal[]`. Each becomes `{id: "p:<goalId>", kind: "plan", projectId, agentId: planBy ?? "boss", goalId, title: "Plan: <text>", text: plan ?? "", since: updatedAt}`.
  - ClientMsg `{type: "plan.answer", goalId: string max 100, option: "approve" | "changes" | "reject", text?: string max 4000}`.
  - ServerMsg `{type: "plan.result", goalId: string, ok: boolean, error?: string}`.
  - `GoalViewSchema` gains `planState: "none" | "proposed" | "approved"` and `plan: string | null`.
- city-server: `computeDecisions` passes `goals: board.plansWaiting()`. The decisions key also includes plan text length, so a revised plan with the same id redraws. `plan.answer` checks the goal's project is watched by this client (as `ownTask` does), else `plan.result` ok false with `<goalId> is not a goal of a project you watch`.

- [ ] **Step 1: Write failing tests:**
  - decisions: `a proposed plan is a plan decision with goalId and the boss`, sorted by `since` with the rest.
  - city-server: `plan.answer approve moves the goal on and replies ok`; `plan.answer for an unwatched project replies ok false`; `the decisions message lists the plan`.
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/decisions.test.ts packages/cli/test/city-server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run build` and the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: plan decisions reach the J queue and plan.answer answers them`.

### Task 5: J panel and board show plans

**Files:**
- Modify: `packages/client/src/ui/decisions.ts`, `packages/client/src/ui/index.ts`, `packages/client/src/ui/board.ts`
- Test: `packages/client/test/decisions.test.ts`, `packages/client/test/board.test.ts`

**Interfaces:**
- Consumes: Task 4 protocol.
- Produces: `DecisionsPanel.setResult(key: string, ok: boolean, error?: string)` matches `d.taskId ?? d.goalId`. index.ts routes `plan.result` to it.

- [ ] **Step 1: Write failing tests:**
  - `plan shows the text and Approve, Request changes, Reject send plan.answer`: Approve sends `{type: "plan.answer", goalId: "g1", option: "approve"}`; Reject sends option `reject`; Request changes with box `"add tests"` sends option `changes` and text.
  - `plan Request changes with an empty box sends nothing`.
  - `plan result error re-enables the buttons`: `setResult("g1", false, "plan is not waiting")`.
  - board: `a proposed goal shows waiting for your OK` in its sub line.
- [ ] **Step 2: Run** `npx vitest run packages/client/test/decisions.test.ts packages/client/test/board.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Plan placeholder text `What should change?`. Board sub line uses `waiting for your OK` in place of the status when `planState === "proposed"`.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: the J panel approves plans and the board shows goals waiting for an OK`.

### Task 6: Budget config, daily usage and the CLI command

**Files:**
- Modify: `packages/safety/src/config.ts`, `packages/safety/src/db.ts`, `packages/safety/src/budget.ts`, `packages/cli/src/wire.ts`, `packages/cli/src/hq.ts`, `packages/world/src/shared/protocol.ts` (HqConfig project gains `budget`)
- Test: `packages/safety/test/config.test.ts`, `packages/safety/test/budget.test.ts`, the CLI wire test file that covers `project edits`

**Interfaces:**
- Produces:
  - Config `budget: { jobTokens: number; dayUsd: number }`, both `nonNeg` with defaults 200000 and 1; `perAgent` removed from the schema (zod strips it on load).
  - `dayKey(d: Date): string` in `budget.ts`, local `YYYY-MM-DD`.
  - Table `usage_days (project_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (project_id, day))`.
  - `Budget.add(projectId, agentId, tokens, usd, day = dayKey(new Date()))` also upserts `usage_days`. `Budget.day(projectId: string, day: string): { tokens: number; usd: number }`.
  - CLI `agentcity project budget <project> <jobTokens> <dayUsd>`: both parse as non-negative numbers, else `fail("Budget must be two numbers of 0 or more.")`. Output `Budget for <id>: <jobTokens> tokens per job, $<dayUsd> per day`.
  - HqConfig project gains `budget: { jobTokens: number; dayUsd: number }`.

- [ ] **Step 1: Write failing tests:**
  - config: `old budget and perAgent load with the new defaults`: JSON with `budget: {maxTokens: 5, maxUsd: 9}` and `perAgent` loads as `budget: {jobTokens: 200000, dayUsd: 1}` and no `perAgent` key.
  - config: `negative jobTokens is config_invalid`.
  - budget: `add counts per day; day() reads one day`; two days kept apart.
  - budget: `dayKey uses local date`.
  - wire: `project budget saves the new shape`; `project budget with a bad number fails`.
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/config.test.ts packages/safety/test/budget.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Gate still compiles: keep `overBudget` compiling by reading the new fields only in Task 7; for this task replace its body with `return false` and mark the commit message accordingly.
- [ ] **Step 4: Run** `npm run build` and `npx vitest run packages/safety packages/cli`. Expected: PASS except gate budget tests, which Task 7 rewrites; mark them `it.skip` with the comment `Task 7 rewrites this`.
- [ ] **Step 5: Commit** `feat: budgets are set per job and per day, with a CLI command`.

### Task 7: Gate enforces job and day caps

**Files:**
- Modify: `packages/safety/src/run-tree.ts`, `packages/safety/src/gate.ts`, `packages/cli/src/job-runner.ts` (BareChatGate), `packages/cli/src/scheduler.ts` (blocked reason copy)
- Test: `packages/safety/test/gate.test.ts`, `packages/cli/test/job-runner.test.ts`, `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 6 config and `Budget.day`, `dayKey`.
- Produces:
  - `RunTree.addTokens(n: number): void`, `get tokens(): number`. `RunTree.overBudget()` and the `tree_budget` checks are removed from the gate.
  - `GateDeps.now?: () => Date` (default `new Date()`), used for `dayKey`.
  - Gate `checkModelCall` and `checkTool`, for a model or agent not on `lmstudio/`: stop `budget_job` when `jobTokens > 0 && tree.tokens >= jobTokens`; stop `budget_day` when `dayUsd > 0 && budget.day(projectId, today).usd >= dayUsd`. `checkTool` uses the model of the last `checkModelCall` (store it on the gate) to decide the `lmstudio/` skip.
  - `recordUsage` calls `tree.addTokens(input + output)`.
  - BareChatGate: same two caps with defaults 200000 tokens per run and $2 per day under project `""`; constants `BARE_CHAT_MAX_TOKENS` and `BARE_CHAT_MAX_USD` become `BARE_CHAT_JOB_TOKENS = 200_000` and `BARE_CHAT_DAY_USD = 2`.
  - Scheduler `why` maps `budget_job` and `budget_day` to the Global Constraints copy, reading the project's config for N and X.

- [ ] **Step 1: Write failing tests:**
  - gate: `job cap stops at jobTokens` (record 200000 tokens, next check stops `budget_job`); `a new RunTree starts at 0`.
  - gate: `day cap stops at dayUsd and the next day allows` (inject `now`).
  - gate: `lmstudio models skip both caps`.
  - gate: `0 turns a cap off`.
  - gate: `claude-sub stops on the job cap only` (dayUsd 1, 300000 tokens over two runs of 150000: neither stops on day; one run at 200000 stops on job).
  - job-runner: `a bare chat stops at 200000 tokens in one run, and the next run starts at 0`.
  - scheduler: `a budget_job stop blocks the task with the job copy`.
  - Delete the `it.skip` tests from Task 6.
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/gate.test.ts packages/cli/test/job-runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run build` and `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: the gate stops a job at its token cap and a project at its daily cap`.

### Task 8: HQ settings Budget form

**Files:**
- Modify: `packages/client/src/ui/hq-settings.ts`
- Test: `packages/client/test/hub-ui.test.ts`

**Interfaces:**
- Consumes: HqConfig project `budget` (Task 6), CLI `project budget` (Task 6).

- [ ] **Step 1: Write failing tests:**
  - `project row shows job 200k tokens · $1/day`.
  - `Budget button opens two number fields; Save runs project budget <id> <tokens> <usd>` through the same `steps` path as the Edits button.
  - `Save with an empty or negative field shows Budget must be two numbers of 0 or more. and runs nothing`.
- [ ] **Step 2: Run** `npx vitest run packages/client/test/hub-ui.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Tag text: tokens over 1000 shown as `<n/1000>k`, 0 shown as `no cap`.
- [ ] **Step 4: Run** the same tests, then `npm run build` and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: HQ settings set each project's budget`.
