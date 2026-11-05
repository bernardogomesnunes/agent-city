# Goal board: goals, tasks, scheduler and code review

## Goal

The player posts a goal to a project. The boss splits it into team tasks, managers split those into worker tasks, and a scheduler in the city server runs ready tasks, each in its own git worktree. Finished work passes tests and a manager review, then waits for the player's Merge with the real diff.

Today a lead holds one long run and calls `delegate` again and again. A 14B local model loses track inside that run, repeats steps and stops at `max_steps`. In the new flow each run is one short job with a clear end, and code decides what runs next.

The design follows agentcraft (MIT, `blendi-remade/agentcraft`, `foreman/src/agents/team.ts`, `taskgraph.ts`, `prompts.ts`), with a third level (managers) added.

## Decisions taken with the player

- Three levels: boss, then manager, then worker. Each level writes tasks to the board. Managers review their own workers.
- A project without a manager: the boss assigns worker tasks directly and reviews them.
- The player never starts a run. Runs still exist inside: one run is one job of one agent on one task.
- Plain chats stay separate and are covered by their own spec (several chats per agent, boss without a project). A boss or manager in a chat gets `create_goal` only.
- The player can message a working agent. The message reaches it with its next tool result.
- Nothing merges without the player's Merge. Nothing is ever pushed.

## 1. Data (`packages/safety/src/board-store.ts`)

Two new tables in the city database, created with `CREATE TABLE IF NOT EXISTS` like the others.

`goals`: `id TEXT PRIMARY KEY` (`g1`, `g2`, ... per database), `project_id`, `text` (max 2000), `status` in `planning | active | done | cancelled | failed`, `created_at`, `updated_at`.

`tasks`: `id TEXT PRIMARY KEY` (`t1`, `t2`, ...), `goal_id`, `parent_id` (null for team tasks), `project_id`, `title` (max 120), `description` (max 2000, holds the acceptance criteria), `assignee`, `deps_json` (task ids), `status`, `branch`, `worktree`, `summary` (max 1000), `blocked_reason`, `ci` in `none | running | pass | fail`, `created_by`, `created_at`, `updated_at`.

`task_runs`: `task_id`, `run_id`, `kind` (job kind below). The task's live log is every action row of these runs.

Task states and allowed moves:

| From | To |
|---|---|
| todo | doing, blocked, cancelled |
| doing | review, blocked, todo, cancelled |
| review | approval, doing, blocked, cancelled |
| approval | done, doing, cancelled |
| blocked | todo, cancelled |
| done, cancelled | todo (retry) |

- A worker task moves to `doing` only when every dep is `done` and it has an assignee.
- A team task (has children) is `doing` while any child is open, `done` when all children are `done` or `cancelled` with at least one `done`, `blocked` when a child is blocked and nothing else can run.
- Deps name tasks of the same goal and parent. No self deps, no cycles: create and update check both.
- A goal is `done` when all team tasks are `done`, `cancelled` when all are `cancelled`. Progress is done worker tasks over all non-cancelled worker tasks.

`BoardStore` holds every read and write. It is the only code that changes `tasks.status`, through `setStatus(id, to, {force?})`, which throws on a move the table forbids.

## 2. Jobs and the scheduler (`packages/cli/src/scheduler.ts`)

The scheduler lives in the city server next to `RunHost` and owns every run of a goal.

| Job | Agent | Starts when | Ends with |
|---|---|---|---|
| plan | boss | a goal is posted | `create_task` calls for team tasks, then the turn ends |
| split | manager | a team task becomes ready | `create_task` calls for worker tasks under it |
| work | worker | a worker task becomes ready | `update_task` to `review` or `blocked` |
| review | manager (or boss) | a worker task reaches `review` and tests ran | `request_merge` or `update_task` back to `doing` |
| followup | any | feedback, a player message, a test failure | as the job it follows |

- Each job is one `runAgent` call with its own run id, `maxSteps` 20 for plan, split and review, 30 for work.
- Concurrency: at most `board.maxConcurrent` work jobs at once, default 1 (local models share one GPU), set per project in `project.json`. Plan, split and review jobs run one at a time per project.
- `tick()` runs after every job end, every task change and every 5 seconds. It starts ready tasks in id order, assignee first; an unassigned task goes to the first free member of the parent manager's team.
- The prompt of each job carries: the goal text, the parent task, the board of that goal (id, state, title, assignee, deps), answered questions on the task, and unread player messages. Agentcraft's `workPrompt` and `reviewPrompt` are the model.
- The existing `Gate`, budget, approval tiers and action log apply to every job unchanged.

### Caps against circles

- A work job that ends with its task still `doing` gets 1 nudge ("call update_task with review or blocked"). After that the task moves to `review` when its worktree has changes, else `blocked` with reason "stopped without changes".
- A plan or split job that creates no task closes the goal (`cancelled`) or blocks the team task.
- A test failure sends the task back to its worker once. A second failure goes to review with the failure attached.
- A manager can send a task back twice. The third review result goes to the player as `approval` with the review notes.
- A merge conflict sends the task back once with "run git merge <base> and resolve". A second conflict blocks it.

### Restart

On start, a task left in `doing` goes back to `todo` with its worktree kept. The next work job prompt says the branch already holds earlier work (`git log <base>..HEAD`). A task left in `review` with no verdict moves to `approval`.

## 3. Tools (`packages/org/src/board-tools.ts`)

| Tool | Who | Tier | Args |
|---|---|---|---|
| `create_task` | boss, managers | 0 | `title`, `description`, `assignee?`, `deps?` (ids) |
| `update_task` | everyone, own tasks only | 0 | `task_id`, `status` (`review`, `blocked`, `doing`), `summary?`, `blocked_reason?` |
| `request_merge` | the reviewer of the task | 0 | `task_id`, `summary` |
| `ask_player` | everyone | 0 | `question`, `options?` |
| `create_goal` | boss and managers in a plain chat | 1 | `project`, `text` |

- `create_task` from the boss makes team tasks assigned to managers. With no `assignee` it goes to the project's first manager. Team tasks never pass through review or approval. From a manager it makes worker tasks under the manager's current team task, assigned to its team.
- An assignee outside the allowed set is an error the model sees, with the allowed ids.
- `ask_player` blocks the task with the question as `blocked_reason` until the player answers in the task view. The answer goes into the next followup prompt.
- `delegate` leaves the goal flow. Leads in goal jobs never get it. It stays for plain chats until the chat spec replaces it.

## 4. Worktrees and git (`packages/cli/src/worktrees.ts`)

- The project root is `workDir(home, config, project)`. A sandbox project gets `git init` and one empty commit on its first goal.
- Base branch: `main`, else `master`, else the branch checked out now (`baseBranch` in `workspace.ts`).
- Each worker task gets a worktree at `<home>/worktrees/<project>/<taskId>` on branch `agent/<agentId>/<taskId>`, cut from the base when the task starts, so merged deps are in it.
- Workers work only there. File tools resolve paths inside the worktree with the existing sandbox checks.
- When a worker moves its task to `review`, the scheduler commits every change in the worktree as `AgentCity <agent name>` with message `<taskId>: <title>`. Workers may also commit themselves.
- Merge: `git merge --no-ff` of the task branch into the base, in the project root, through `mergeAgentBranch`. It refuses uncommitted changes in the root and aborts on conflict.
- After a merge the worktree is removed and the branch kept. A cancelled task keeps its branch and loses its worktree.

## 5. Tests and review

- Test command: `board.testCommand` in `project.json`, else `npm test` when the worktree's `package.json` has a `test` script, else none.
- Tests run in the worktree with a 5 minute timeout. The last 4 KB of output is kept on the task.
- The review prompt carries the worker's summary, the test result and the diff (base to branch), cut to 12 000 characters.
- `request_merge` moves the task to `approval`. The player then sees it in the review list.

### Diff (`packages/cli/src/diff.ts`)

- `git diff --no-color <base>...<branch>` parsed into files: `path`, `status` (`added | modified | deleted | renamed`), `additions`, `deletions`, and hunks of lines `{kind: add | del | ctx, text, oldNo?, newNo?}`.
- At most 200 files and 2000 lines per file. A cut file says so. Binary files show only their status.

## 6. Talking to a working agent

- `runAgent` gets an optional `inbox: () => string[]`. After each batch of tool results it appends every waiting message as one user message: `Message from the player: <text>`.
- A chat message to an agent that has a running job goes to that job's inbox. With no running job it starts a followup on the agent's current task, or a plain chat turn when it has none.
- The task view has a message box that sends to the task's current agent.

## 7. Plain chats (`packages/safety/src/sessions.ts`, `packages/cli/src/session-host.ts`)

- The player starts as many chats as they want with any agent, with or without a project.
- `sessions` loses `UNIQUE (project_id, agent_id)` and gains `title` (the first player message cut to 60 characters). `project_id` is empty for a chat without a project. A migration copies old rows into the new table and keeps their ids and messages.
- A chat turn is one `runAgent` call of that agent with the chat history. It never takes the project's work slot. Turns of one chat run in order; chats of one agent run one at a time.
- Chat tools with a project: `read_file`, `list_files`, `search_files` in the project root, `remember`, and `create_goal` for the boss and managers. Without a project: `remember`, plus `create_goal` for the boss and managers.
- No chat writes files or runs commands. Changes go through goals and tasks, so every change gets a branch and a review.
- `create_goal` (tier 1) names an existing project. The boss without a project asks the player which project when the request needs one.
- A chat message to an agent with a running job goes to that job's inbox (section 6). The chat shows "sent to <agent> on <task id>".
- `delegate` and the session branch reuse in `prepareWorkspace` are removed.

## 8. Protocol (`packages/world/src/shared/protocol.ts`)

Client to server:

- `goal.submit {projectId, text}`
- `board.watch {projectId}`: goals and tasks of the project, and live updates while watched.
- `task.open {taskId}`: the task with its log, files and preview info.
- `task.message {taskId, text}`
- `task.action {taskId, action: retry | cancel}`
- `task.answer {taskId, text}`: answers an `ask_player` question.
- `review.answer {taskId, option: merge | changes | reject, text?}`: `changes` sends the text to the worker as a followup; `reject` cancels the task.
- `diff.request {taskId}`

Server to client:

- `board {projectId, goals: GoalView[], tasks: TaskView[]}`
- `task.detail {task: TaskView, log: LogRow[], files: FileTree}`
- `task.log {taskId, rows: LogRow[]}`: new rows while the task is open.
- `diff {taskId, files: DiffFile[]}`
- `review.result {taskId, ok, error?}`

`LogRow` is `{ts, agentId, kind: text | tool | result | error, text}` built from action rows of the task's runs, redacted, each text cut to 500 characters.

## 8. Interface (`packages/client/src/ui/board.ts`)

- The software house panel shows the board above Developers: a goal input, then each goal with its progress bar and its team tasks.
- A team task opens to its worker tasks as cards in columns todo, doing, review, approval, done. Blocked cards show their reason in red.
- A selected task has tabs:
  - **Log**: the live log, newest at the bottom, with the message box.
  - **Diff**: files on the left, lines on the right, added lines green and removed lines red, line numbers on both sides.
  - **Files** and **Preview**: the file tree and the framed `index.html` from the project board plan, rooted at the task's worktree.
- A task in `approval` shows Merge, Request changes (with a text box) and Reject above the diff. The HUD shows a count of tasks waiting for approval.
- All text goes in through text nodes.

## 9. What changes in existing code

- `packages/world/src/board.ts` (the `Plan:` parser from the project board plan, Task 1) is removed. Its step tracking is replaced by tasks.
- Project board Task 2 (`project-files.ts`) and Task 3 (the preview route) are kept and take a root path, so they serve a task worktree or the project root.
- `LEAD_RULES` in `org/src/prompt.ts` give way to job prompts. `buildSystemPrompt` keeps persona, tools, skills and notes.
- The progress panel of top runs shows goal jobs by task id until the board panel replaces it.

## 10. Tests

- `board-store.test.ts`: every allowed and forbidden move, deps checks and cycles, team task state from children, goal state and progress.
- `scheduler.test.ts` with a scripted provider: a goal runs plan, split, work, review and approval in order; deps hold a task back; the concurrency cap; each cap in "Caps against circles"; restart recovery.
- `board-tools.test.ts`: who may create what, own-task checks, assignee errors.
- `worktrees.test.ts` on a temp repo: worktree path and branch, auto commit, merge, conflict abort, sandbox `git init`.
- `diff.test.ts`: added, deleted, renamed and binary files, line numbers, both caps.
- `run-agent` inbox test: a message waiting after a tool result is the next user message.
- Client tests: goal list, columns, task tabs, diff colors, the three review buttons, text nodes only.

## Out of scope

- Several chats per agent and a boss chat without a project (their own spec).
- Pushing, pull requests and remotes.
- Running tests outside the worktree, or in a container.
- Moving a task between goals.
