# Projects Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Projects panel with three levels (list, project, task), an Inbox popup for every request, chat from a task or goal, task pause, project delete, and the handheld dialog style.

**Architecture:** Server work first: a `held` flag on tasks, a `project remove` command, and sessions that carry a task or goal. Then the client: style tokens, top bar and Inbox, then the Projects panel and its task thread, mounted in HQ Work's left column. The existing `decisions` push feeds the Inbox; the existing `task.detail` push feeds the task thread.

**Tech Stack:** TypeScript, vitest, zod, better-sqlite3, ws, jsdom, Phaser client.

**Spec:** `docs/superpowers/specs/2026-11-04-projects-panel-design.md`. Mockups: `docs/ux/mockups/panel-styles.html` (style B), `docs/ux/mockups/style-b-surfaces.html`.

## Global Constraints

- Branch `feat/projects-panel` off master.
- Style B tokens: cream `#f8f4e6`, border `#3a3f5c` 4px, inner rule `#8a90b8` 2px, radius 8px; buttons white, 2px `#3a3f5c`, radius 4px.
- Status colors: blue `#3fb7ff` working, amber `#ffb020` needs you, red `#e24b4a` blocked, gray `#8a8f9e` idle or paused, green `#48b048` done.
- Body text 13px minimum; headings and labels Silkscreen 11 to 14px; tool output and paths monospace 12px.
- No Nintendo assets. Every add button reads "Add".
- Delete copy, verbatim: "Delete <name>? Runs stop. Goals, tasks and agent branches leave the city. The folder stays on disk."
- Empty list copy, verbatim: "Start your first project".
- Errors, verbatim: "No project <id>", "stop the runs first".
- Task log in level 3 renders at most the last 200 rows.
- Tests: `npx vitest run <file>`; full suite `npx vitest run`; lint `npm run lint`.

## Rulings

- Silkscreen loads from Google Fonts in `packages/client/index.html` with a monospace fallback. Bundling the font file needs a download; cost if wrong: offline pages show monospace headings.
- The Inbox shows the four decision kinds that exist today: question, approval, plan, merge. A login or key request reaches the player as a question from the agent. A separate "login" kind waits for an agent tool that asks for one. Cost if wrong: one more card kind later.
- The goal's Manager is the `createdBy` of its first task whose author has role `manager`, else the first project agent with role `manager`, else the first project agent.

## Review Focus

1. A project is deleted while its panel is open at level 2 or 3: the panel returns to level 1.
2. A task is deleted or its project removed while a chat about it is open: the chat stays as history, and sending says the task is gone.
3. A held task in a paused project: Resume of the project leaves the task held.
4. A task log with more than 200 rows: level 3 shows the last 200 and stays responsive.
5. The Inbox count is 0: the button reads "Inbox" in the plain button style.

---

### Task 1: Held tasks in the store and scheduler

**Files:**
- Modify: `packages/safety/src/db.ts` (add column), `packages/safety/src/board-store.ts` (Task type, `setHeld`)
- Modify: `packages/cli/src/scheduler.ts` (`action` union, tick and ready filter)
- Modify: `packages/world/src/shared/protocol.ts` (TaskView `held`, task.action enum)
- Test: `packages/safety/test/board-store.test.ts`, `packages/cli/test/scheduler.test.ts`, `packages/world/test/protocol.test.ts`

**Interfaces:**
- Produces: `BoardStore.setHeld(taskId: string, held: boolean): Task`; `Task.held: boolean`; `Scheduler.action(taskId, "retry" | "cancel" | "rollback" | "pause" | "resume")`; `TaskView.held: boolean`; `task.action` accepts `"pause"` and `"resume"`.

- [ ] **Step 1: Write failing tests**
  - board-store: `setHeld persists and reloads` (create task, `setHeld(id, true)`, new store on the same db reads `held === true`); `old db gains held` (db made without the column opens and reads `held === false`).
  - scheduler: `pause aborts the task's job and holds it` (running work job aborted with stop "pause", task `held === true`, worktree kept, status back to `todo`); `tick skips a held task` (held todo task gets no job after `tick()`); `resume clears held and ticks` (job starts); `pause on an idle task holds it` (returns `{ ok: true }`); `project resume keeps held tasks held` (Review Focus 3).
  - protocol: `task.action accepts pause and resume`; `TaskView requires held`.
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/board-store.test.ts packages/cli/test/scheduler.test.ts packages/world/test/protocol.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Column `held INTEGER NOT NULL DEFAULT 0`, added with `ALTER TABLE` when missing, like `checkpoint`. `ready()` and the tick skip held tasks. `pause` reuses the project pause abort path for one task: abort only that task's work or review job with stop "pause", run the same recovery for that task, then `setHeld(true)`. `resume` sets held false and calls `tick()`. The task view mapper in `city-server.ts` passes `held`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: pause and resume a single task`.

### Task 2: Project remove

**Files:**
- Modify: `packages/safety/src/board-store.ts` (`deleteProject`), `packages/cli/src/worktrees.ts` (`removeAgentBranches`), `packages/cli/src/scheduler.ts` (`forget`), `packages/cli/src/wire.ts` (`project remove <id>`), `packages/cli/src/city-server.ts` (hq.do path)
- Test: `packages/safety/test/board-store.test.ts`, `packages/cli/test/worktrees.test.ts`, `packages/cli/test/cli.test.ts`, `packages/cli/test/city-server.test.ts`

**Interfaces:**
- Produces: `BoardStore.deleteProject(projectId: string): void` (goals, tasks, task_runs, task_notes, goal_notes, paused row); `removeAgentBranches(repo: string): string[]` (removes `agent/*` worktrees and branches, returns removed names); `Scheduler.forget(projectId: string): Promise<{ ok: true } | { ok: false; error: string }>`; CLI `agentcity project remove <id>` exit 0 on success, 1 with "No project <id>".

- [ ] **Step 1: Write failing tests**
  - board-store: `deleteProject drops only that project` (two projects with goals and tasks; after delete, the other keeps its rows).
  - worktrees: `removeAgentBranches keeps non-agent branches and files` (repo with `main`, `agent/a`, `feature/x`; result `["agent/a"]`; `feature/x` and the working tree files stay).
  - cli: `project remove deletes config and keeps the folder` (linked folder still exists with its files; `project show` fails after); `project remove unknown fails` (stderr has "No project nope").
  - city-server: `hq.do project remove while a run will not stop answers stop the runs first` (fake host whose stop never settles within 10 s, using fake timers).
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/board-store.test.ts packages/cli/test/worktrees.test.ts packages/cli/test/cli.test.ts packages/cli/test/city-server.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `forget`: `pause(projectId)`, wait up to 10 s for the project's jobs and `host.busy(projectId)` to clear, else return "stop the runs first"; then `deleteProject`, `removeAgentBranches` when the workspace is a git repo, then remove `projectDirs(home, id).root` except the linked folder. The CLI command calls the same steps through the scheduler when the city runs, and directly on the store when it does not. Broadcast config, board and decisions after.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: project remove`.

### Task 3: Chats about a task or goal

**Files:**
- Modify: `packages/safety/src/db.ts` and `packages/safety/src/sessions.ts` (columns `task_id`, `goal_id`; `create` options)
- Modify: `packages/cli/src/session-host.ts` (`create` takes a ref; first turn context)
- Modify: `packages/cli/src/task-log.ts` (`taskContext`)
- Modify: `packages/world/src/shared/protocol.ts` (`session.new` fields), `packages/cli/src/city-server.ts`
- Test: `packages/safety/test/sessions.test.ts`, `packages/cli/test/task-log.test.ts`, `packages/cli/test/city-server.test.ts`

**Interfaces:**
- Produces: `SessionStore.create(projectId, agentId, opts?: { title?: string; taskId?: string; goalId?: string }): Session`; `Session.taskId?: string`, `Session.goalId?: string`; `taskContext(task: Task, rows: LogRow[], redact: (s: string) => string): string`; ClientMsg `session.new { agentId, projectId?, taskId?, goalId? }`.

- [ ] **Step 1: Write failing tests**
  - sessions: `create stores title and task` (title "Fix broken index.html", `taskId` "t1" read back).
  - task-log: `taskContext lists title, description, status, branch and the last 15 rows` (20 rows in, 15 out, newest last, each cut to 120 chars).
  - city-server: `session.new with taskId titles the chat with the task title`; `first turn of a task chat carries the context` (job prompt starts with the `taskContext` text); `session.new with goalId titles it with the goal text`; `session.new for a removed agent opens the goal's Manager and says so` (first system line names the Manager); `send to a chat whose task is gone says so` (Review Focus 2: system line "the task is gone").
- [ ] **Step 2: Run** `npx vitest run packages/safety/test/sessions.test.ts packages/cli/test/task-log.test.ts packages/cli/test/city-server.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Columns added with `ALTER TABLE` when missing. `SessionHost.create(agentId, projectId?, ref?: { taskId?: string; goalId?: string })` resolves the title from the board and stores the ref. `runTurn` prepends `taskContext` (or the goal text and its task titles with status) on the session's first user message only.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: chats that carry a task or goal`.

### Task 4: Style B tokens

**Files:**
- Modify: `packages/client/src/ui/style.css`, `packages/client/index.html` (font link)
- Test: `packages/client/test/hud.test.ts` (one style check)

**Interfaces:**
- Produces: CSS custom properties on `:root`: `--box-fill`, `--box-line`, `--box-rule`, `--btn-fill`, `--st-run`, `--st-ask`, `--st-block`, `--st-idle`, `--st-done`, `--font-pixel`; classes `.ac-box`, `.ac-button`, `.st-dot` with modifiers `.run .ask .block .idle .done`, `.ac-sec` (section label), `.ac-mono`.

- [ ] **Step 1: Write failing test** `style tokens exist`: load `style.css` text and assert it declares the 10 custom properties with the Global Constraints values, and that `.ac-box` uses `var(--box-fill)`.
- [ ] **Step 2: Run** `npx vitest run packages/client/test/hud.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Restyle `.ac-box` and `.ac-button` to style B so every existing panel changes at once. Body 13px; `.ac-title` and `.ac-sec` use `--font-pixel`.
- [ ] **Step 4: Run** the same command, then open the city (preview "city") and screenshot HQ. Expected: PASS; panels show the cream box.
- [ ] **Step 5: Commit** `feat: handheld dialog style tokens`.

### Task 5: Top bar and Inbox popup

**Files:**
- Create: `packages/client/src/ui/inbox.ts`
- Modify: `packages/client/src/ui/hud.ts` (one row: status, Inbox, Stop all, Chat, Terminal, Roofs, HQ; bell removed), `packages/client/src/ui/hq-settings.ts` (bell toggle moves here), `packages/client/src/ui/hq-panel.ts` (drop Approvals box, Terminal button and error line), `packages/client/src/ui/index.ts` (wire Inbox; remove `DecisionsPanel` mount; errors as toast)
- Delete: `packages/client/src/ui/decisions.ts` after its answer logic moves to `inbox.ts`
- Test: `packages/client/test/inbox.test.ts` (new), `packages/client/test/hud.test.ts`, `packages/client/test/hq-panel.test.ts`; `packages/client/test/decisions.test.ts` moves into `inbox.test.ts`

**Interfaces:**
- Consumes: ServerMsg `decisions { list: DecisionView[] }`.
- Produces: `class Inbox { constructor(parent: HTMLElement, send: Send); render(list: DecisionView[]): void; open(): void; close(): void; get count(): number }`; `Hud.setInbox(n: number)`; `toast(text: string, ms = 6000): void` in `packages/client/src/ui/alerts.ts`.

- [ ] **Step 1: Write failing tests**
  - inbox: `one card per decision, oldest first`; `question card has an answer box, Answer and Skip, and Roll back only with a checkpoint`; `approval card sends Allow and Deny`; `plan card sends Approve and Send back`; `merge card sends Merge and hides on Later`; `answering removes the card`.
  - hud: `Inbox button shows the count in amber`; `count 0 reads Inbox in the plain style` (Review Focus 5); `no bell button`.
  - hq-panel: `Work has no Approvals box`; `HQ bar has no Terminal button`.
- [ ] **Step 2: Run** `npx vitest run packages/client/test/inbox.test.ts packages/client/test/hud.test.ts packages/client/test/hq-panel.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Port the message sends from `decisions.ts`. The Roll back button needs the task's `checkpoint`: read it from the board views the client already holds; hide the button when null.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: top bar and inbox popup`.

### Task 6: Projects panel, levels 1 and 2

**Files:**
- Create: `packages/client/src/ui/projects-panel.ts`
- Modify: `packages/client/src/ui/hq-panel.ts` (Work layout `left: ["projects"]`, `right: ["activity", "performance", "analytics"]`; drop `work-projects` and `buildings` boxes; Configure Projects box renamed to keep its id `config-projects`), `packages/client/src/ui/hq-work.ts` (drop `renderProjectsWork`), `packages/client/src/ui/index.ts`, `packages/client/src/ui/hq-settings.ts` ("Add" labels)
- Test: `packages/client/test/projects-panel.test.ts` (new), `packages/client/test/hq-panel.test.ts`

**Interfaces:**
- Consumes: `HqConfig.projects`, board views (`GoalView`, `TaskView` with `held`), `decisions` list, `paused` project ids, `Send`.
- Produces: `class ProjectsPanel { constructor(parent: HTMLElement, send: Send, hooks: { chat(ref: { agentId: string; projectId: string; taskId?: string; goalId?: string }): void; run: HqDo }); render(s: PanelState): void; open(projectId?: string, taskId?: string): void; level: 1 | 2 | 3 }`; `managerOf(goal: GoalView, tasks: TaskView[], agents: AgentConfigView[]): string`.

- [ ] **Step 1: Write failing tests**
  - `level 1 lists projects with dot, done count, working count, inbox count and paused tag` (gamenew: amber dot, "2 of 5", "1 working", "2").
  - `no projects shows Start your first project and New project`.
  - `a row opens level 2; Back returns to level 1; a redraw keeps the level`.
  - `level 2 sorts tasks: Working now = doing and review, Backlog = todo, blocked and approval, Delivered = done newest first`.
  - `goal Chat calls chat with the Manager from managerOf`; `task Chat calls chat with the assignee, or the Manager when unassigned`.
  - `Pause sends project.pause; Delete shows the verbatim confirm and Delete runs project remove`.
  - `the open project disappears: panel returns to level 1` (Review Focus 1).
  - `New project form runs project create, then submits the goal`; `the form names skills and MCP servers the chosen agents lack`.
  - hq-panel: `Work shows Projects left and Activity, Performance, City right; no Buildings box`.
- [ ] **Step 2: Run** `npx vitest run packages/client/test/projects-panel.test.ts packages/client/test/hq-panel.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** The panel sends `board.watch` for every project on open, as `BuildingPanel.watchLinked` does. `hooks.chat` opens the dock and sends `session.new` with the ref.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: projects panel list and project levels`.

### Task 7: Task thread, level 3, and chat buttons on the goal board

**Files:**
- Create: `packages/client/src/ui/task-thread.ts`
- Modify: `packages/client/src/ui/projects-panel.ts` (level 3), `packages/client/src/ui/board.ts` (Chat button per task; open level 3 in place in the Software house), `packages/client/src/ui/dock.ts` (`openRef`)
- Test: `packages/client/test/task-thread.test.ts` (new), `packages/client/test/board.test.ts`, `packages/client/test/dock.test.ts`

**Interfaces:**
- Consumes: ServerMsg `task.detail { task, log: LogRow[] }`; `ProjectsPanel` hooks from Task 6.
- Produces: `renderThread(box: HTMLElement, task: TaskView, log: LogRow[], send: Send): void`; `Dock.openRef(ref: { agentId: string; projectId: string; taskId?: string; goalId?: string }): void`.

- [ ] **Step 1: Write failing tests**
  - task-thread: `text rows render as reasoning blocks, tool rows as boxed blocks with name and one-line result, error rows red`; `a blocked task's question renders an amber block with an answer box that sends task.answer`; `more than 200 rows renders the last 200` (Review Focus 4); `header shows title, agent, branch and step count`; `Pause sends task.action pause; a held task shows Resume`; `Open chat calls the chat hook with the assignee and taskId`; `Retry, Cancel, Roll back and the diff stay under the thread`.
  - board: `each task row has Chat calling the chat hook`.
  - dock: `openRef sends session.new with taskId and shows the new chat`.
- [ ] **Step 2: Run** `npx vitest run packages/client/test/task-thread.test.ts packages/client/test/board.test.ts packages/client/test/dock.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Follow new rows live: re-render on each `task.detail` for the open task and keep the scroll at the bottom when it was at the bottom.
- [ ] **Step 4: Run the same command, then the full suite** `npx vitest run` and `npm run lint`. Expected: all PASS, lint clean.
- [ ] **Step 5: Browser check.** Preview "city": HQ Work shows the Projects panel; open gamenew, open a task, press Chat; open the Inbox. Screenshots of each, no console errors.
- [ ] **Step 6: Commit** `feat: task thread and chat from tasks`.
