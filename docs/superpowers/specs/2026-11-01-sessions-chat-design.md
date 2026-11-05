# Sessions and chat design

## Goal

The player talks to agents in conversations that last. A message to the boss on a project starts work, the boss reports progress while its team works, and its answer shows in the same thread. The player can also talk to any developer directly. Today a run takes one goal, its final answer never shows in the UI, and the next run starts with no memory of the last.

## Decisions (from the user)

- A session is one thread per agent and project, for example Boss on Game New. New run opens the existing thread for that pair or starts it.
- Each turn the agent sees the player's earlier messages and its own earlier answers. Tool calls and tool results are left out. Notes from `remember` load as today.
- A message sent while the agent works waits in the thread as `queued` and starts the next turn.
- Progress: a `report` tool any agent in the tree can call, plus automatic lines when a `delegate` call starts and ends. `delegate` keeps waiting for the child as today.
- A project runs one agent tree at a time. A session whose project is busy shows "waiting for <project>" and starts when the project is free.
- UI: a dock fixed to the bottom, always present, folded by default. Its default view is the session list with a New run button.

## Storage

Two tables in `agentcity.db`, created by `openDb`:

| Table | Columns |
|---|---|
| `sessions` | `id INTEGER PRIMARY KEY`, `project_id`, `agent_id`, `created_at`, `branch` (nullable), `UNIQUE(project_id, agent_id)` |
| `session_messages` | `id INTEGER PRIMARY KEY`, `session_id`, `ts`, `kind` (`user`, `agent`, `report`, `system`), `author` (agent id, or `you`), `text`, `status` (`queued`, `running`, `done`), `run_id` (nullable) |

`status` matters for `user` rows only. Other kinds are written as `done`. All text goes through `redact` with the stored secrets before it is written. `text` holds at most 4000 characters, the goal limit. A new `SessionStore` in `safety` owns both tables: `open(projectId, agentId)`, `list()`, `messages(sessionId, limit)`, `append(...)`, `setStatus(...)`, `nextQueued(projectId)`.

Startup: a row left `running` by a crashed city becomes `done` with a `system` line "stopped: city restarted".

## Turns

`SessionHost` in `cli` sits on `RunHost`:

1. `send(projectId, agentId, text)` opens the session, appends a `user` row as `queued`, then calls `pump(projectId)`.
2. `pump` returns when `RunHost.busy(projectId)`. Otherwise it takes the oldest `queued` row of that project, any session, marks it `running`, and starts the turn.
3. The turn runs the agent tree with the new message as the goal and the thread as history (below).
4. On stop: `done` appends an `agent` row with the answer. Any other reason appends the answer (when not empty) and a `system` row "stopped: <reason>, <steps> steps". The `user` row becomes `done`. Then `pump(projectId)` runs again.
5. Whenever any run on the project stops (a terminal run included), `pump` runs for that project.

Runs started from the terminal (`agentcity run`) do not touch sessions.

History: `RunAgentOptions` gains `history?: Array<{ role: "user" | "assistant"; content: string }>`. The messages become system prompt, then history, then the goal. History is built from the thread's `user` and `agent` rows, oldest first, without the new message. `trimMessages` already drops the oldest messages to fit `contextWindow`; history goes through it like the rest.

Branches: a session in a linked git repo keeps one branch across turns. The first turn creates `agent/<agent>-<time>` as today and stores it in `sessions.branch`. Later turns check out that branch. After `project merge` merges it, the stored branch clears and the next turn creates a new one. `prepareWorkspace` gains an optional `branch` to reuse. `workspace_dirty` still refuses a turn, as a `system` line.

## Progress lines

- `report`: tool tier 0, args `{ text: string (1 to 500) }`. It appends a `report` row, author the calling agent, to the session that started the tree, and returns "reported". With no session (a terminal run) it returns "reported" and writes nothing. `report` joins the default `allowedTools`, and the gate allows it in projects made before this change.
- Prompt: agents in a session tree get one more system prompt line: "Use report to tell the player about progress on long tasks."
- Automatic: when `delegate` starts, a `system` row "<parent> handed '<task, 80 chars>' to <child>". When it ends, "<child> finished: <answer, 160 chars>", or "<child> stopped: <reason>".
- Approvals for a session's tree stay in the approvals table as today. The client shows them inside the thread by project.

## Protocol

| Client to server | Server to client |
|---|---|
| `session.send {projectId, agentId, text}` | `session.list {sessions: [{id, projectId, agentId, status, queued, last}]}` |
| `session.open {projectId, agentId}` | `session.thread {sessionId, messages}`: the last 200 rows |
| `session.stop {projectId}` | `session.msg {sessionId, message}`: one new or changed row, pushed to every tab |

Session status is `idle`, `working` (its turn runs), `queued` (its turn runs and more messages wait behind it) or `waiting` (it has a queued message and another tree holds the project). `queued` in `session.list` is the number of waiting messages. `session.stop` stops the running tree, the same as Stop on the progress panel. Queued rows stay queued.

## UI: the dock

- Folded: one 28 px bar at the bottom. It shows the session count and the latest line, for example "Boss · Game New: working, step 5". A click or `C` unfolds it to 35% of the window height. Fold state is kept in localStorage.
- Tabs: Chat and Terminal. The terminal moves into the dock. `T` and backtick open the dock on Terminal.
- Chat, left part: the session list, the default view. Each row shows agent, project, status and the last line. "+ New run" turns the list into a form (project, agent, Open) with Back and Cancel, as in the HQ containers.
- Chat, right part: the open thread.
  - The header shows agent, project and status, plus Stop while a turn runs.
  - Player messages sit on the right, agent answers on the left.
  - Report and automatic lines are small and grey, with their author.
  - Pending approvals for the project show with Approve and Deny.
  - The input is a textarea. Enter sends and Shift+Enter adds a new line. Sending while offline flashes the HUD as today.
- On a narrow window (under 700 px) the list and the thread take turns: picking a session shows the thread with a Back button.
- HQ columns, the side panels and the preview end above the dock bar. HQ Work drops its Start run container.
- The agent card gets "Message", which opens the agent's thread for the last project it worked on, or the New run form with the agent picked.

## Errors

- Unknown agent or project: `error` message, nothing stored.
- Text empty or over 4000 characters: refused on the client and the server.
- Provider errors stop the turn with a `system` line that carries the provider message, redacted.

## Testing

- `SessionStore`: open is unique per pair, append redacts, `nextQueued` order across sessions, crash recovery.
- `SessionHost` with a scripted provider:
  - A message runs, and the answer is stored.
  - A second message queues behind the first.
  - A busy project makes the session `waiting`.
  - History holds user and agent rows only.
  - A stop reason adds a `system` line.
  - The branch is reused across turns.
- `report` and delegate lines land in the top session. A terminal run writes none.
- `runAgent` with `history`: the message order is system prompt, then history, then goal.
- Client:
  - Dock fold and keys.
  - List, then New run form, then Back.
  - Thread rendering by kind.
  - Queued and waiting badges.
  - Enter sends and Shift+Enter does not.
  - Approvals in the thread.

## Out of scope

- Async delegation, where the boss turn ends while workers run.
- Parallel trees on one project and per-session worktrees.
- Editing or deleting messages, and search.
