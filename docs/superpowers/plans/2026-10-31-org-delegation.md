# Agent City part 2: Org delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Boss delegates to a Manager, the Manager to a Worker, answers flow back up, every handoff passes the gate, and each agent keeps a notes file.

**Architecture:** `delegate` is an ordinary tier 1 tool whose `run` starts a child `runAgent` and returns its answer. One in-memory `RunTree` per top run carries shared limits; every gate in the tree checks it. The cli wires child runs through an injected `startChild`, so `org` never imports `safety`.

**Tech Stack:** TypeScript, Node 22+, npm workspaces, vitest, zod 4, better-sqlite3, commander (all from part 1).

**Spec:** `docs/superpowers/specs/2026-10-31-org-delegation-design.md`

## Global Constraints

- Import direction: `cli` imports `org`, `safety`, `core`. `org` and `safety` import `core` only. `core` imports none of them.
- Part 1 tests (174) keep passing. New fields on shared types are optional where part 1 call sites would break.
- Ids: `^[a-z0-9-]{1,32}$`, and not one of `con`, `prn`, `aux`, `nul`, `com1`..`com9`, `lpt1`..`lpt9`.
- `delegation` defaults: `{ maxDepth: 3, maxTreeUsd: 0.5, maxChildRuns: 10 }`.
- Notes file: `agents/<id>/memory/notes.md`. Prompt holds the last 4000 chars. `remember` note 1 to 500 chars.
- `delegate` task 1 to 4000 chars. Team line persona excerpt: first 100 chars.
- Secrets never reach a log row, approval row, notes file or stdout unredacted.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A child whose model needs a missing Anthropic key: the parent gets `child stopped: no_provider` and continues; the CLI does not exit. Test in Task 7.
2. Approval asked by a child: the prompt line starts with the child's name. Test in Task 7.
3. Ctrl+C while a child waits for approval: every approver in the tree is cancelled, pending approvals denied, exit 130. Test in Task 7.
4. A single notes line longer than 4000 chars: `tail` returns its last 4000 chars. Test in Task 5.
5. A secret value inside a `remember` note or `delegate` task: stored and logged as `[secret]`. Test in Task 5 (notes) and Task 7 (log).

---

### Task 1: Core run ids, answer, provider error detail

**Files:**
- Modify: `packages/core/src/agent/run-agent.ts`, `packages/core/src/events.ts`, `packages/core/src/tools/types.ts`
- Test: `packages/core/test/run-agent.test.ts`

**Interfaces:**
- Produces:
```ts
// RunAgentOptions gains:
runId?: string;        // default: randomBytes(6).toString("hex")
parentRunId?: string;
// RunResult gains:
runId: string; answer: string; detail?: string;
// Event Base gains: runId: string; parentRunId?: string
// run.stopped gains: detail?: string
// ToolContext gains: runId?: string; depth?: number   (absent depth means 0)
```
- `answer`: text of the last assistant message with non-empty text, `""` if none, for every stop reason.
- `detail`: on `provider_error`, the last caught error's message. Absent otherwise.
- `runAgent` passes `toolContext` to tools with `runId` set to this run's id (keep caller's `depth`).

- [ ] **Step 1: Write failing tests:** `result carries runId given by caller`, `runId defaults to 12 hex chars`, `every event carries runId and parentRunId`, `answer is the final text on done`, `answer is the last non-empty text on max_steps`, `provider_error result and run.stopped carry detail with the error message`, `tool receives toolContext.runId equal to the run id`.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/run-agent.test.ts`. Expected: 7 new FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all pass, 181 total.
- [ ] **Step 5: Commit** `feat(core): run ids, final answer and provider error detail`.

### Task 2: Config delegation defaults and reserved ids

**Files:**
- Modify: `packages/safety/src/config.ts`, `packages/safety/src/home.ts`, `packages/org/src/profile.ts`
- Test: `packages/safety/test/config.test.ts`, `packages/safety/test/home.test.ts`, `packages/org/test/store.test.ts`

**Interfaces:**
- Produces: `ProjectConfig.delegation: { maxDepth: number; maxTreeUsd: number; maxChildRuns: number }`. Schema uses `.default(...)` so a file without it loads with the defaults. `export function isReservedId(id: string): boolean` in `packages/safety/src/home.ts`, and a copy of the same list in `packages/org/src/profile.ts` (org may not import safety).
- `projectDirs` and `AgentProfileSchema` reject reserved ids.

- [ ] **Step 1: Write failing tests:** `old project.json without delegation loads with defaults 3, 0.5, 10`, `delegation with negative maxTreeUsd is config_invalid`, `projectDirs rejects "con" and "lpt1"`, `create rejects agent id "nul"`, `id "console" is allowed`.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** `maxDepth` and `maxChildRuns` are non-negative integers.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(safety): delegation limits in project config; reject reserved ids`.

### Task 3: Run ids in the action log; redacted approvals

**Files:**
- Modify: `packages/safety/src/db.ts`, `packages/safety/src/action-log.ts`, `packages/safety/src/approvals.ts`
- Test: `packages/safety/test/action-log.test.ts`, `packages/safety/test/approvals.test.ts`

**Interfaces:**
- Consumes: event `runId`, `parentRunId` from Task 1.
- Produces:
```ts
ActionLog.append(e: { ...; runId?: string; parentRunId?: string }): number;
interface ActionRow { ...; runId: string | null; parentRunId: string | null }
ActionLog.sink(): copies e.runId and e.parentRunId into the columns, not the payload.
new ApprovalQueue(db, secrets: string[] = [])   // redacts args before INSERT
```
- `openDb` adds `run_id TEXT` and `parent_run_id TEXT` with `ALTER TABLE` when `PRAGMA table_info(actions)` lacks them. Append-only triggers stay.

- [ ] **Step 1: Write failing tests:** `append stores runId and parentRunId`, `sink puts runId in columns and not in payload`, `opening a part 1 db adds the columns and keeps old rows with null`, `approval args with a secret are stored as [secret]`.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.** For the old-db test, create the part 1 `actions` table by hand in a temp db, insert one row, then call `openDb`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(safety): run ids in action log; redact approval args`.

### Task 4: RunTree and gate delegation checks

**Files:**
- Create: `packages/safety/src/run-tree.ts`
- Modify: `packages/safety/src/gate.ts`, `packages/safety/src/index.ts`
- Test: `packages/safety/test/run-tree.test.ts`, `packages/safety/test/gate.test.ts`

**Interfaces:**
- Consumes: `delegation` config (Task 2), `append` run ids (Task 3).
- Produces:
```ts
export class RunTree {
  constructor(limits: { maxDepth: number; maxTreeUsd: number; maxChildRuns: number });
  addUsd(usd: number): void;
  readonly usd: number;
  readonly childRuns: number;
  overBudget(): boolean;   // usd >= maxTreeUsd
  reserveChild(depth: number): { ok: true } | { ok: false; reason: "depth_limit" | "child_run_limit" };
  // depth > maxDepth -> depth_limit; childRuns >= maxChildRuns -> child_run_limit; else childRuns++
}
// GateDeps gains:
tree: RunTree; depth: number; runId: string; parentRunId?: string;
roleOf: (agentId: string) => "boss" | "manager" | "worker" | undefined;
canDelegate: (from: "boss" | "manager" | "worker", to: "boss" | "manager" | "worker") => boolean;
```
- `canDelegate` is injected (org owns it, Task 5). Gate checks for tool name `delegate`, after the allowlist and budget checks, in spec order: `target_not_granted`, `target_missing`, `role_not_allowed` (also when the caller's own role is undefined), `self_delegation`, then `tree.reserveChild(depth + 1)`. Each is a `deny` with rule `delegation`. Passing all gives `allow` with rule `tier1`.
- `tree.overBudget()` gives `stop("tree_budget")`, rule `tree_budget`, in both `checkModelCall` and `checkTool`, right after the existing budget check.
- `recordUsage` calls `tree.addUsd(usd)`. Every `log.append` in the gate passes `runId` and `parentRunId`.

- [ ] **Step 1: Write failing tests.** RunTree: `reserveChild(4) with maxDepth 3 is depth_limit`, `11th reserve with maxChildRuns 10 is child_run_limit`, `overBudget at usd equal to max`. Gate (extend the part 1 gate helper with a tree, depth 0, runId `r1`, `roleOf` from a map, and a `canDelegate` matching the spec): `delegate to ungranted agent denied target_not_granted`, `delegate to unknown agent denied target_missing`, `manager delegating to boss denied role_not_allowed`, `self delegation denied self_delegation`, `delegate at depth 3 denied depth_limit`, `valid delegate allowed and counts one child run`, `model call stops with tree_budget when tree usd reached`, `recordUsage adds to tree usd`, `gate rows carry runId r1`.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Update existing gate test helpers for the new required deps.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(safety): run tree limits and delegate checks in the gate`.

### Task 5: Org roles, memory store, remember and delegate tools

**Files:**
- Create: `packages/org/src/roles.ts`, `packages/org/src/memory.ts`, `packages/org/src/tools.ts`
- Modify: `packages/org/src/index.ts`
- Test: `packages/org/test/roles.test.ts`, `packages/org/test/memory.test.ts`, `packages/org/test/tools.test.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolContext`, `RunResult` from core (Task 1).
- Produces:
```ts
export function canDelegate(from: AgentRole, to: AgentRole): boolean;
export class MemoryStore {
  constructor(home: string);
  read(agentId: string): string;
  tail(agentId: string, maxChars: number): string;
  append(agentId: string, line: string): void;
  clear(agentId: string): void;
}
export type StartChild = (agentId: string, task: string, parent: ToolContext) => Promise<RunResult>;
export function makeDelegateTool(startChild: StartChild): Tool<{ agent: string; task: string }>;  // name "delegate", tier 1
export function makeRememberTool(memory: MemoryStore, redactText: (s: string) => string): Tool<{ note: string }>;  // name "remember", tier 1
```
- `tail`: if the file is at most `maxChars`, return it whole. Otherwise take the last `maxChars` chars and drop up to the first `\n` in that slice; if the slice has no `\n`, return the slice as is.
- `remember` writes `- <ISO date> <note>` with newlines in the note replaced by spaces, after `redactText`, to `ctx.agentId`'s file only. Returns `remembered`.
- `delegate` returns the child's `answer` when `reason === "done"`, else `child stopped: <reason>` plus `\n` and the answer when the answer is non-empty.
- File writes use the part 1 write-temp-then-rename helper from `store.ts`.

- [ ] **Step 1: Write failing tests:** `canDelegate boss->manager, boss->worker, manager->worker true; all others false` (9 pairs), `append then read`, `tail keeps whole lines`, `tail of one 5000-char line returns its last 4000 chars`, `clear empties the file`, `remember writes a dated line to the caller's notes only`, `remember replaces newlines and redacts`, `remember rejects a 501-char note via schema`, `delegate returns the answer on done`, `delegate returns child stopped: budget plus partial answer`, `delegate passes the parent ToolContext to startChild`.
- [ ] **Step 2: Run** `npx vitest run packages/org/test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(org): roles, notes memory, delegate and remember tools`.

### Task 6: System prompt with team and notes

**Files:**
- Modify: `packages/org/src/prompt.ts`
- Test: `packages/org/test/prompt.test.ts`

**Interfaces:**
- Produces:
```ts
export function buildSystemPrompt(
  profile: AgentProfile,
  project: { id: string; allowedTools: string[] },
  extra?: { team?: AgentProfile[]; notes?: string },
): string;
```
- Order: persona, `\n\n`, part 1 rules, then `\n\nTeam you may delegate to:\n` with one line per team member `<id> (<role>): <first 100 chars of persona>`, then `\n\nYour notes:\n<notes>`. Each block is omitted when its list is empty or notes are empty. The caller filters `team` (Task 7).

- [ ] **Step 1: Write failing tests:** `no extra gives the part 1 prompt unchanged`, `team block lists id, role and 100-char persona excerpt`, `notes block follows the team block`, `empty notes omit the block`.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(org): team and notes in the system prompt`.

### Task 7: CLI tree runner

**Files:**
- Create: `packages/cli/src/tree-runner.ts`
- Modify: `packages/cli/src/wire.ts` (the `run` and `init` commands)
- Test: `packages/cli/test/tree.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces:
```ts
export interface TreeRunnerDeps {
  home: string; project: string; db: Database.Database; secrets: string[];
  global: GlobalConfig; keys: Record<string, string>; providerOverride?: Provider;
  io: CliIo; out: (line: string) => void; signal: AbortSignal;
}
export class TreeRunner {
  constructor(deps: TreeRunnerDeps);
  run(agentId: string, goal: string, opts?: { model?: string }): Promise<RunResult>;  // top run, depth 0
  cancelAll(): void;   // cancels every approver created so far
  closeAll(): void;
  lastProviderError(): unknown;
}
```
- One `RunTree` per `TreeRunner`, built from the project's `delegation` config (defaults if the config is invalid; the gate stops on invalid config anyway).
- Per run (top or child): load profile (missing child profile returns a `RunResult` with reason `target_missing` without calling the model); pick provider with `providerFor` (an error returns reason `no_provider`, detail = message); new `TerminalApprover(io, profile.name)`; new `Gate` with the shared tree, `depth`, new `runId`, `parentRunId`, `roleOf` from `AgentStore`, `canDelegate` from org; tools = part 1 built-ins + `remember` + `delegate` only when `canDelegate(role, "worker")`; prompt via `buildSystemPrompt` with `team` = granted profiles the role may delegate to, minus self, and `notes` = `MemoryStore.tail(id, 4000)`; `toolContext.depth` = depth.
- `startChild(agentId, task, parent)` runs the child at `parent.depth + 1` with `parentRunId = parent.runId` and the same signal.
- `run` command in `wire.ts` uses `TreeRunner`; the interrupt handler calls `cancelAll()` in place of the single approver cancel. Exit codes unchanged.
- `init` adds `delegate` and `remember` to `allowedTools`.

- [ ] **Step 1: Write failing tests** (FakeProvider script keyed by system prompt start, temp home, agents `boss`, `mgr`, `ada` with roles boss, manager, worker, all granted):
  - `boss to mgr to ada returns ada's answer to the boss`
  - `ada's tool list has no delegate`
  - `log rows of the child carry parent_run_id equal to the boss run id`
  - `child over maxTreeUsd stops with tree_budget and boss gets child stopped: tree_budget`
  - `kill switch set during child run stops child and boss with killed`
  - `abort during a child approval cancels it, denies pending, exits 130`
  - `child approval prompt line starts with the child's name`
  - `child whose model needs a missing anthropic key returns child stopped: no_provider`
  - `a secret in a delegate task is logged as [secret]`
  - `boss prompt lists mgr and ada in the team block; mgr prompt lists only ada`
  - `init enables delegate and remember`
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/tree.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `wire.ts` behavior for part 1 tests; move run wiring into `tree-runner.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, part 1 cli tests included.
- [ ] **Step 5: Commit** `feat(cli): run delegation trees`.

### Task 8: CLI memory and log tree commands

**Files:**
- Modify: `packages/cli/src/wire.ts`
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (Task 5), `ActionRow.runId/parentRunId` (Task 3).
- Produces: commands `agent memory <id> [--clear]` and `log <project> --tree`.
- `agent memory <id>` prints the notes, or `No notes.` when empty. Unknown agent exits 1 with `No agent <id>.`
- `--clear` asks `Clear notes for <id>? [y/N] `; only `y` clears; prints `Cleared.` or `Kept.`.
- `--tree`: rows grouped by `run_id` in order of first appearance; each group starts with `run <runId> <agentId>`, indented 2 spaces per level found by walking `parent_run_id`; rows print with the existing format, indented one more level. Rows with null `run_id` print first, unindented.

- [ ] **Step 1: Write failing tests:** `agent memory prints notes`, `agent memory on empty notes prints No notes.`, `agent memory --clear with y empties, with n keeps`, `log --tree indents mgr under boss and ada under mgr`.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(cli): agent memory and log --tree`.

### Task 9: Live tree run and done check

**Files:**
- Modify: `packages/cli/test/live.live.test.ts`, `README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add live test** `lmstudio boss delegates to mgr, mgr to ada, ada writes a sandbox file` (skipped when LM Studio is down, like part 1). Setup creates `boss`, `mgr`, `ada` with LM Studio models and grants them. Asserts: a file exists in the sandbox, `log --tree` output has 3 `run ` lines at indents 0, 2, 4.
- [ ] **Step 2: README:** add a "Teams" section with the 6 setup commands and one `run --agent boss` example, plus `agent memory` and `log --tree`.
- [ ] **Step 3: Run** `npm test`, `npm run typecheck`, `npm run lint`. Expected: all clean.
- [ ] **Step 4: Manual check:** run the live test against LM Studio with `qwen/qwen3-14b`. Expected: pass, 3 nested runs in the log.
- [ ] **Step 5: Commit** `test(cli): live delegation tree; docs for teams`.
