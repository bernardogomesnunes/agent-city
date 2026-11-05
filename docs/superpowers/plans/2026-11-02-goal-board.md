# Goal Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Goals split into tasks that a scheduler runs in git worktrees, with live logs, manager review, the player's Merge on a real diff, and plain chats with any agent.

**Architecture:** `BoardStore` in `@agentcity/safety` holds goals and tasks. A `Scheduler` in the city server starts one short `runAgent` job per step (plan, split, work, review, followup) with board tools from `@agentcity/org`. Worktrees, tests and diffs live in `@agentcity/cli`. The client gets a board panel and a chat list per agent.

**Tech Stack:** TypeScript, vitest with jsdom, zod protocol, better-sqlite3, git CLI, node http.

**Spec:** `docs/superpowers/specs/2026-11-02-goal-board-design.md`

## Global Constraints

- Task states: `todo | doing | review | approval | done | blocked | cancelled`, with exactly the moves in spec section 1.
- Goal states: `planning | active | done | cancelled | failed`. Ids are `g<n>` and `t<n>`.
- Lengths: goal text 2000, task title 120, description 2000, summary 1000, chat title 60, log row text 500, test output tail 4096 bytes, review diff 12 000 characters.
- `maxSteps`: 20 for plan, split and review jobs, 30 for work jobs. `board.maxConcurrent` default 1. Test timeout 5 minutes. Tick every 5 seconds.
- Caps: 1 nudge, 1 test fix, 2 send-backs, 1 conflict retry.
- Worktree path `<home>/worktrees/<project>/<taskId>`, branch `agent/<agentId>/<taskId>`, commit author `AgentCity <agent name>`, message `<taskId>: <title>`.
- Diff caps: 200 files, 2000 lines per file.
- Never push. Never merge without `review.answer` `merge`.
- Every user-facing text in the client is built with text nodes, never `innerHTML`.
- Files are CRLF on disk: edit with the Edit tool, or normalize `\r\n` before matching in scripts.
- Every task ends with `npm run build` clean and `npx vitest run` green.
- Tests that need git use a temp repo from `fs.mkdtempSync`. No test touches `~/.agentcity`.

## Review Focus

- A worker that marks its task `review` with no file changes: the scheduler moves it to `blocked` "no changes". Test in Task 6.
- A merge when the project root has uncommitted changes: `review.answer` returns an error and the task stays in `approval`. Test in Task 7.
- A task id from another project in `task.open` or `review.answer`: the server returns an error and changes nothing. Test in Task 7.
- A dep cycle made through two `create_task` calls: the second call returns an error to the model. Test in Task 1.
- A restart with a task in `doing` and its worktree on disk: the task returns to `todo` and the next work job reuses the worktree. Test in Task 6.

---

### Task 1: Board store

**Files:**
- Create: `packages/safety/src/board-store.ts`
- Modify: `packages/safety/src/db.ts` (tables `goals`, `tasks`, `task_runs`), `packages/safety/src/index.ts`
- Test: `packages/safety/test/board-store.test.ts`

**Interfaces:**
- Produces:
  - `type TaskStatus = "todo" | "doing" | "review" | "approval" | "done" | "blocked" | "cancelled"`
  - `type GoalStatus = "planning" | "active" | "done" | "cancelled" | "failed"`
  - `interface Goal { id; projectId; text; status: GoalStatus; createdAt; updatedAt }`
  - `interface Task { id; goalId; parentId: string | null; projectId; title; description; assignee: string | null; deps: string[]; status: TaskStatus; branch: string | null; worktree: string | null; summary: string | null; blockedReason: string | null; ci: "none" | "running" | "pass" | "fail"; testOutput: string | null; sendBacks: number; nudges: number; testFixes: number; conflicts: number; createdBy; createdAt; updatedAt }`
  - `class BoardError extends Error`
  - `class BoardStore(db, secrets = [], now = () => new Date())` with:
    - `createGoal(projectId, text): Goal`, `goal(id)`, `goals(projectId): Goal[]`, `setGoalStatus(id, s)`
    - `createTask({goalId, parentId?, title, description, assignee?, deps?, createdBy}): Task` (throws `BoardError` on an unknown dep, a dep outside the same goal and parent, a self dep or a cycle)
    - `task(id)`, `tasks(goalId): Task[]`, `children(taskId): Task[]`, `ready(goalId): Task[]` (worker tasks in `todo` with all deps `done`, id order)
    - `update(id, patch: Partial<Pick<Task, "title"|"description"|"assignee"|"deps"|"branch"|"worktree"|"summary"|"blockedReason"|"ci"|"testOutput"|"sendBacks"|"nudges"|"testFixes"|"conflicts">>): Task`
    - `setStatus(id, to, opts?: {force?: boolean}): Task` (throws on a move the spec table forbids unless `force`)
    - `rollup(goalId): void` (team task and goal states from children, spec section 1)
    - `progress(goalId): {done: number; total: number}`
    - `addRun(taskId, runId, kind)`, `runs(taskId): Array<{runId; kind}>`
- Text fields are cut to the Global Constraints lengths and redacted with `redact` before writing.

- [ ] **Step 1: Write the failing tests** in `board-store.test.ts` with `openDb` on a temp dir:
  - ids count `g1`, `t1`, `t2`.
  - Every allowed move in the spec table passes; `todo -> done`, `done -> doing` and `approval -> review` throw `BoardError`; `force` allows them.
  - `createTask` with deps `["t9"]` throws; a dep under another parent throws; `t2 deps [t3]` then `update(t3, {deps: [t2]})` throws "cycle".
  - `ready` holds back a task whose dep is `doing` and lists it once the dep is `done`.
  - Rollup: a team task with children `done` and `cancelled` is `done`; with one child `doing` it is `doing`; a goal with all team tasks `done` is `done`, all `cancelled` is `cancelled`.
  - `progress` counts worker tasks only and skips cancelled ones.
  - A 3000-character description is stored as 2000; a secret in a summary is stored redacted.
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/board-store.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the tables and `BoardStore`. Ids come from `SELECT COUNT(*)+1` inside a transaction. The cycle check walks deps from the new deps back to the task.
- [ ] **Step 4: Run** `npx vitest run packages/safety`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: board store for goals and tasks`.

### Task 2: Worktrees, tests and diff

**Files:**
- Create: `packages/cli/src/worktrees.ts`, `packages/cli/src/diff.ts`
- Modify: `packages/cli/src/workspace.ts` (export `baseBranch`, `git`)
- Test: `packages/cli/test/worktrees.test.ts`, `packages/cli/test/diff.test.ts`

**Interfaces:**
- Produces in `worktrees.ts`:
  - `ensureRepo(root: string): void` (`git init` plus an empty commit when `root` has no `.git`)
  - `worktreePath(home, project, taskId): string`
  - `openWorktree(root, path, branch): {path; branch; base}` (reuses an existing worktree at `path`, else `git worktree add -b branch path base`)
  - `commitAll(path, author: string, message: string): {committed: boolean; files: number}`
  - `changedFiles(path, base): number` (files differing from base, committed or not)
  - `mergeTask(root, branch): {ok: true} | {ok: false; detail: string}` (wraps `mergeAgentBranch`; accepts `agent/<agent>/<task>`)
  - `removeWorktree(root, path): void` (keeps the branch)
  - `testCommand(path, configured?: string): string | undefined`
  - `runTests(path, command, timeoutMs = 300_000): Promise<{pass: boolean; output: string}>` (output is the last 4096 bytes)
- Produces in `diff.ts`:
  - `type DiffLine = {kind: "add" | "del" | "ctx"; text: string; oldNo?: number; newNo?: number}`
  - `type DiffFile = {path; status: "added" | "modified" | "deleted" | "renamed" | "binary"; additions; deletions; hunks: DiffLine[][]; truncated: boolean}`
  - `parseDiff(text: string): DiffFile[]`, `taskDiff(root, base, branch): DiffFile[]`, `diffText(files, max = 12_000): string`

- [ ] **Step 1: Write the failing tests.**
  - worktrees on a temp repo: `ensureRepo` on a plain folder makes one commit; `openWorktree` twice returns the same path; `commitAll` with author `AgentCity Dev` sets that author; `changedFiles` counts 2 after two writes; `mergeTask` merges and leaves base checked out; a conflicting branch returns `ok: false` and `git status` is clean after; uncommitted changes in root return `ok: false`.
  - `testCommand`: a `package.json` with `scripts.test` gives `npm test`; configured `"pnpm t"` wins; none gives undefined.
  - `runTests` with `node -e "process.exit(1)"` gives `pass: false`.
  - diff: a fixture diff text with an added, a deleted, a renamed and a binary file parses to those statuses; line numbers count from hunk headers; 2500 lines in one file give 2000 and `truncated`; 250 files give 200.
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/worktrees.test.ts packages/cli/test/diff.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Git runs through `execFileSync("git", args, {cwd})`. Commit with `-c user.name=<name> -c user.email=agents@agentcity.local` and never `-S`.
- [ ] **Step 4: Run** `npx vitest run packages/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: task worktrees, test runs and diffs`.

### Task 3: Inbox for a running agent

**Files:**
- Modify: `packages/core/src/agent/run-agent.ts`
- Test: `packages/core/test/run-agent.test.ts`

**Interfaces:**
- Produces: `RunAgentOptions.inbox?: () => string[]`. After each batch of tool results, waiting messages are appended as one `{role: "user", content: "Message from the player: <a>\n\nMessage from the player: <b>"}`, and an event `{type: "inbox", count}` is emitted.

- [ ] **Step 1: Write the failing test:** a fake provider makes one tool call, then answers. `inbox` returns `["stop and use blue"]` once. The second provider request's last message is the user message `Message from the player: stop and use blue`.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/run-agent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in the loop after tool results; add `inbox` to the `AgentEvent` union in `core/src/events.ts`.
- [ ] **Step 4: Run** `npx vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: messages reach a running agent`.

### Task 4: Board tools and job prompts

**Files:**
- Create: `packages/org/src/board-tools.ts`, `packages/org/src/job-prompts.ts`
- Modify: `packages/org/src/index.ts`
- Test: `packages/org/test/board-tools.test.ts`, `packages/org/test/job-prompts.test.ts`

**Interfaces:**
- Consumes: `BoardStore`, `Task`, `Goal` (Task 1).
- Produces:
  - `interface BoardToolCtx { board: BoardStore; goalId: string; taskId?: string; agentId: string; role: "boss" | "manager" | "worker"; allowedAssignees: string[]; onChange(): void; onQuestion(taskId: string, q: string): void }`
  - `makeCreateTaskTool(ctx)`, `makeUpdateTaskTool(ctx)`, `makeRequestMergeTool(ctx)`, `makeAskPlayerTool(ctx)`: tier 0, args as spec section 3.
  - `makeCreateGoalTool(post: (project: string, text: string) => {ok: true; goalId: string} | {ok: false; error: string})`: tier 1.
  - `planPrompt(goal, board: Task[], members)`, `splitPrompt(goal, team: Task, board, members)`, `workPrompt(goal, task, board, opts: {worktree; branch; base; answers: string[]; inbox: string[]; continues: boolean})`, `reviewPrompt(task, summary, test: {command?: string; pass?: boolean; output?: string}, diff: string)`, `nudgePrompt(taskId)`, `JOB_RULES: Record<"boss"|"manager"|"worker", string>`.
- Tool results are short strings the model reads, such as `created t4` or `error: assignee must be one of dev, ana`.

- [ ] **Step 1: Write the failing tests.**
  - boss `create_task` without assignee goes to the first manager in `allowedAssignees`; parent is null.
  - manager `create_task` sets `parentId` to `ctx.taskId` and refuses an assignee outside its team with the allowed ids in the message.
  - `create_task` with a cycle returns `error: ...cycle...` and creates nothing.
  - worker `update_task` on another agent's task returns an error; on its own task to `review` with a summary moves it and calls `onChange`.
  - `request_merge` from a non-reviewer errors; from the reviewer moves `review -> approval`.
  - `ask_player` blocks the task with the question as reason and calls `onQuestion`.
  - `workPrompt` holds the task id, title, worktree path, base branch, each answer and each inbox line; `continues: true` adds `git log <base>..HEAD`.
  - `reviewPrompt` holds `PASS` or `FAIL` and the diff text.
- [ ] **Step 2: Run** `npx vitest run packages/org`. Expected: FAIL.
- [ ] **Step 3: Implement.** Prompt wording follows agentcraft `foreman/src/agents/prompts.ts` (`workerSystemPrompt`, `workPrompt`, `reviewPrompt`), rewritten for boss, manager and worker. Keep every rule line under 25 words for local models.
- [ ] **Step 4: Run** `npx vitest run packages/org`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: board tools and job prompts`.

### Task 5: Job runner

**Files:**
- Create: `packages/cli/src/job-runner.ts`
- Test: `packages/cli/test/job-runner.test.ts`

**Interfaces:**
- Consumes: board tools (Task 4), `runAgent` with `inbox` (Task 3).
- Produces:
  - `interface Job { kind: "plan" | "split" | "work" | "review" | "followup"; projectId; goalId; taskId?; agentId; prompt: string; cwd: string }`
  - `class JobRunner(deps: {home; db; secrets; global; keys; providerOverride?; approvals: WebApprovals; out(line): void})` with `run(job, tools: AnyTool[], signal, inbox: () => string[]): Promise<RunResult>`.
- It builds provider, `Gate`, file tools rooted at `job.cwd`, `remember`, skills and MCP tools the way `TreeRunner.runOne` does, without `delegate` or `report`. Leads (plan, split, review) get no write or command tools. `maxSteps` per Global Constraints.

- [ ] **Step 1: Write the failing tests** with a scripted provider: a work job's `write_file` lands in `job.cwd`; a review job has no `write_file` in its tool specs; a work job gets `maxSteps` 30; the run logs `run.started` with the job's agent.
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/job-runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the shared setup out of `TreeRunner.runOne` into a helper both use.
- [ ] **Step 4: Run** `npx vitest run packages/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: job runner for one board job`.

### Task 6: Scheduler

**Files:**
- Create: `packages/cli/src/scheduler.ts`
- Test: `packages/cli/test/scheduler.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5.
- Produces `class Scheduler(deps: {home; board: BoardStore; jobs: Pick<JobRunner, "run">; agents: AgentStore; onChange(projectId): void; now?})` with:
  - `submitGoal(projectId, text): Goal`
  - `tick(): Promise<void>`, `start()` (5 second timer), `stop()`
  - `message(taskId, text): void` (to the running job's inbox, else a followup)
  - `answer(taskId, text): void` (`ask_player` answer: unblock, followup)
  - `review(taskId, option: "merge" | "changes" | "reject", text?): {ok: true} | {ok: false; error: string}`
  - `action(taskId, "retry" | "cancel"): void`
  - `recover(): void` (spec "Restart")
  - `runningTask(agentId): string | undefined`

- [ ] **Step 1: Write the failing tests** with a fake `jobs.run` that calls the given tools from a script per job kind, on a temp git repo project:
  - A goal runs plan (boss makes 1 team task), split (manager makes 2 worker tasks, `t3` deps `t2`), work `t2`, tests, review, `approval`; `t3` starts only after `review(t2, "merge")`.
  - `maxConcurrent` 1 holds the second ready task while one work job runs.
  - A work job that ends with its task `doing` gets one `nudgePrompt` followup; a second end moves it to `review` when files changed, `blocked` "stopped without changes" when not.
  - A failing test command sends the task back once; the second failure reaches review with `FAIL`.
  - The third manager send-back moves the task to `approval`.
  - `message` while a job runs reaches the inbox function; with no job it enqueues a followup.
  - `recover` turns `doing` into `todo` and the next work prompt contains `git log`.
  - `review(..., "merge")` with uncommitted root changes returns `ok: false` and the task stays `approval`.
- [ ] **Step 2: Run** `npx vitest run packages/cli/test/scheduler.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with agentcraft `team.ts` (`schedule`, `startWork`, `afterTurn`, `ciThenReview`, `sendBackToWorker`, `onUserMessage`) as the model. One job queue per agent. Each job records `board.addRun`.
- [ ] **Step 4: Run** `npx vitest run packages/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: scheduler runs goals as tasks`.

### Task 7: Plain chats and server wiring

**Files:**
- Modify: `packages/safety/src/db.ts`, `packages/safety/src/sessions.ts`, `packages/cli/src/session-host.ts`, `packages/cli/src/city-server.ts`, `packages/world/src/shared/protocol.ts`, `packages/safety/src/action-log.ts` (`ofRuns(runIds, afterId?)`)
- Create: `packages/cli/src/project-files.ts`, `packages/cli/src/task-log.ts`
- Test: `packages/safety/test/sessions.test.ts`, `packages/cli/test/city-server.test.ts`, `packages/cli/test/project-files.test.ts`, `packages/world/test/protocol.test.ts`

**Interfaces:**
- Produces in protocol: the spec section 8 messages, plus `GoalViewSchema`, `TaskViewSchema` (Task fields without counters), `LogRowSchema`, `DiffFileSchema`, `FileTreeSchema`, and chat messages `session.new {agentId, projectId?}`, `session.open {sessionId}`, `session.send {sessionId, text}`. `SessionViewSchema` gains `title` and makes `projectId` optional.
- Produces `SessionStore.create(projectId | "", agentId): Session`, `SessionStore.forAgent(agentId): Session[]`, `Session.title`.
- Produces `listFiles(root, protectedPaths): Promise<FileTree>` and `readProjectFile(root, rel, protectedPaths)` as in the project board plan Task 2 (skip `.git` and `node_modules`, 500 entries, 200 KB, NUL in first 8 KB is binary, `resolveInSandbox`).
- Produces `taskLog(log: ActionLog, runIds: string[], redactText, afterId?): LogRow[]`.
- The preview route `GET /p/<previewKey>/<taskId>/<path>` from the project board plan Task 3 serves the task worktree, or the project root once merged, with the CSP and headers of spec section 3 of the project board design.

- [ ] **Step 1: Write the failing tests.**
  - sessions: the migration keeps an old row's id, messages and branch; two `create` calls for one pair give two sessions; `create("", "boss")` works; `title` is the first user message cut to 60.
  - city-server: `goal.submit` creates `g1` and broadcasts `board` to watchers; `task.open` for a task of another project returns an error; `review.answer merge` with a dirty root returns `review.result ok: false`; `diff.request` returns `diff`; a chat `session.send` to an agent with a running job goes to the scheduler's `message`.
  - project-files: `..`, an absolute path, a protected file, 500 entries, 200 KB, binary.
  - preview: 200 with the CSP for `index.html`; 404 for a wrong key, `%2e%2e`, `%5C` and an unknown task.
  - protocol: every new message parses; a `review.answer` with option `ship` fails.
- [ ] **Step 2: Run** `npx vitest run packages/safety packages/cli packages/world`. Expected: FAIL.
- [ ] **Step 3: Implement.** Chat turns run through `JobRunner` with kind `followup` and the chat tool set of spec section 7. Remove the session branch reuse from `prepareWorkspace`. The migration renames `sessions` to `sessions_old`, creates the new table, copies rows, drops the old one, inside one transaction guarded by a `PRAGMA user_version` check.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: board and chat messages in the city server`.

### Task 8: Board panel

**Files:**
- Create: `packages/client/src/ui/board.ts`, `packages/client/src/ui/diff-view.ts`
- Modify: `packages/client/src/ui/building-panel.ts` (a `board` slot above the main slot), `packages/client/src/index.ts`, `packages/client/src/ui/hud.ts` (approval count), `packages/client/src/ui/style.css`
- Test: `packages/client/test/board.test.ts`

**Interfaces:**
- Consumes the Task 7 messages.
- Produces `class BoardView(send: (m: ClientMsg) => void)` with `root`, `setBoard(goals, tasks)`, `setDetail(task, log, files)`, `appendLog(taskId, rows)`, `setDiff(taskId, files)`, `setReviewResult(ok, error?)`.

- [ ] **Step 1: Write the failing tests** in jsdom:
  - The goal input sends `goal.submit`. Each goal shows `done of total` and its team tasks.
  - A team task opens to five columns with cards in the right column; a blocked card shows its reason.
  - Clicking a card sends `task.open` and shows tabs Log, Diff, Files, Preview; the Log tab's box sends `task.message`.
  - The Diff tab renders add lines with class `diff-add`, del lines with `diff-del`, both line numbers, and a cut file note.
  - A task in `approval` shows Merge, Request changes and Reject; Request changes sends its text.
  - A log text `<img src=x onerror=alert(1)>` renders as text: no `img` element exists.
  - The preview frame has `sandbox="allow-scripts"` and no `allow-same-origin`.
- [ ] **Step 2: Run** `npx vitest run packages/client/test/board.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The view is built once per visit and updated in place, so the preview frame keeps running.
- [ ] **Step 4: Run** `npx vitest run packages/client`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: board panel with task log, diff and review`.

### Task 9: Chat list per agent

**Files:**
- Modify: `packages/client/src/ui/dock.ts`, `packages/client/src/ui/agent-card.ts`, `packages/client/src/index.ts`
- Test: `packages/client/test/dock.test.ts`

**Interfaces:**
- Consumes `session.new`, `session.open {sessionId}`, `session.send {sessionId}` (Task 7).
- Produces `Dock.openNew(agentId, projectId?)` and `Dock.openSession(sessionId)`.

- [ ] **Step 1: Write the failing tests:** the agent card has a "New chat" button that sends `session.new`; the session list shows each chat with its title and agent; two chats of one agent are two rows; sending in a chat sends its `sessionId`; a chat without a project shows "no project".
- [ ] **Step 2: Run** `npx vitest run packages/client/test/dock.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run packages/client`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: several chats per agent`.

### Task 10: Remove the old flow and check in the browser

**Files:**
- Delete: `packages/world/src/board.ts`, `packages/world/test/board.test.ts`
- Modify: `packages/org/src/prompt.ts` (drop `LEAD_RULES`), `packages/cli/src/tree-runner.ts` (no `delegate` for goal jobs), `packages/world/src/index.ts`, `packages/world/src/shared/protocol.ts` (drop the Task 1 board schemas of the project board plan)

- [ ] **Step 1:** Remove the code; fix every compile error `npm run build` reports.
- [ ] **Step 2: Run** `npm run build` and `npx vitest run`. Expected: clean and PASS.
- [ ] **Step 3: Browser check** on the preview server (config `city`, port 4321, scratch `AGENTCITY_HOME`, open `http://127.0.0.1:4321/`): post a goal on the pong project, watch tasks appear, open a task log, open its diff, press Merge. Screenshot each step.
- [ ] **Step 4: Commit** `refactor: goals replace delegate chains`.
