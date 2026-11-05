# Projects panel and handheld dialog style

Branch `feat/projects-panel`. Built on the UI audit in `docs/ux/2026-11-04-ui-audit.md`. Mockups: `docs/ux/mockups/panel-styles.html` (style B, levels 2 and 3) and `docs/ux/mockups/style-b-surfaces.html` (top bar, Inbox, level 1, delete, new project, chat, stats, Configure). Both approved 2026-11-04. The stats tile "tokens" in the mockup shows spend until the city counts tokens; counting tokens is out of scope.

## Why

The player tracks work across 4 project views, 3 lists of things that wait on them, and a goal board 4 steps deep. Nothing shows what an agent is doing on one task. Projects cannot be removed. The text is about 9px and every box has the same weight.

## What the player can do

1. See every project in one list, with its state in one line.
2. Open a project: progress, goals, who works now, backlog, delivered.
3. Open a task: the agent's reasoning, tool calls and questions as a thread.
4. Chat about a task with its agent, or about a goal with its Manager.
5. Pause a project or a task. Delete a project.
6. Create a project with a name, folder, goal and agents.
7. Answer every agent request from one popup in the top bar.

## Layout

### Top bar (one row)

City status, Inbox count, Stop all, Chat (C), Terminal (T), Roofs (R). The bell moves to Configure. The HQ bar's Terminal button and its error line go away; command errors show as a toast for 6 seconds.

### Inbox popup

The Inbox count opens a popup under the top bar. It lists every item that waits on the player, oldest first, one card each:

- task question (answer box, Answer, Skip, and Roll back when the task has a checkpoint)
- tool approval (Allow, Deny)
- plan OK (Approve, Send back)
- merge (Merge, Later)
- login or key request (Open, Done)

A card shows project, agent, one sentence, and its buttons. Answering removes the card. The floating Decisions panel and the HQ Approvals box go away. The count covers all five kinds.

### HQ Work

Left column: Projects panel. Right column: Activity, Performance · 7 days, City · 7 days. The HQ Work Projects box and the Buildings box go away.

### HQ Configure

Unchanged: Agents, Projects, Skills, APIs, MCP servers. Every add button reads "Add".

### Software house

Keeps its goal board as the focused view inside that building. The board gains the same task Chat buttons and opens level 3 in place.

## Projects panel

Three levels in the same panel. Back returns one level. The panel keeps its level across redraws.

### Level 1: list

"New project" button at the top. One row per project:

- status dot: blue working, amber needs you, red blocked, gray idle or paused
- name
- "3 of 8 done" over all goals
- "2 working" when agents run
- amber count of Inbox items for this project
- "paused" tag when paused

A row opens level 2. No projects: one line "Start your first project" and the New project button.

### Level 2: project

- Header: Back, name, Pause or Resume, Delete.
- Progress bar over all tasks of active goals.
- Goals: one row each with "2 of 5 done" and Chat, which opens the Manager.
- Working now: tasks in doing or review. Row: status dot, title, agent, Chat.
- Backlog: tasks in todo, blocked or approval.
- Delivered: done tasks, newest first, with the merge state.
- A task row opens level 3. Chat opens the chat panel.
- Goal box at the bottom: "A goal for the team" and Submit goal.

### Level 3: task

- Header: Back, status dot, title, agent, branch, step count, time since the run started.
- Progress: the task log as a thread, newest at the bottom, following new rows live.
  - reasoning: plain block with a left rule
  - tool call: boxed block, tool name and a one-line result
  - question to the player: amber block with an answer box
  - error: red block
- Footer: Pause or Resume (this task only), Open chat.
- Retry, Cancel, Roll back and the diff stay as they are in the task detail today, under the thread.

## Chat from a task or goal

- Task Chat opens the dock with a new conversation titled with the task title, with the task's assignee. A task with no assignee opens the goal's Manager.
- Goal Chat opens a new conversation titled with the goal text, with the goal's Manager. The Manager is the `createdBy` of the goal's tasks, or the project's manager agent when the goal has no tasks.
- The first turn of that conversation carries the task or goal: title, description, status, the last 15 log rows, and the branch.
- `session.new` gets optional `taskId` and `goalId`. The session stores them and its title.

## Task pause

- New task action `pause`: aborts the task's running job with stop "pause" and marks the task held. A held task keeps its status and worktree and the tick skips it.
- `resume` clears held and ticks.
- `tasks` gets `held INTEGER NOT NULL DEFAULT 0`. `TaskView` gets `held: boolean`.

## Project delete

- CLI `project remove <id>`, also sent through `hq.do`.
- Asks in the UI: "Delete <name>? Runs stop. Goals, tasks and agent branches leave the city. The folder stays on disk."
- Steps: pause the project, abort its jobs, delete its goals, tasks, notes, queue items and paused row, remove its worktrees and `agent/*` branches, remove it from the config.
- A project with a run that will not stop in 10 seconds answers "stop the runs first".

## New project

The form: name, folder (empty for a sandbox), first goal, agents (checkboxes). Under the agents, a line lists MCP servers and skills the project names that no chosen agent has. Create runs the existing `project create` steps, then submits the goal.

## Style B: handheld dialog

- Panel: cream fill `#f8f4e6`, 4px border `#3a3f5c`, inner rule 2px `#8a90b8`, radius 8px.
- Headings and section labels: Silkscreen, 11 to 14px. Body: the system sans at 13px. Tool output and paths: monospace 12px.
- Buttons: white fill, 2px border `#3a3f5c`, radius 4px, Silkscreen 11px.
- Status colors: blue `#3fb7ff` working, amber `#ffb020` needs you, red `#e24b4a` blocked, gray `#8a8f9e` idle, green `#48b048` done.
- Progress bar: 8px, 2px border, green fill.
- Inbox popup and toasts use the same box. Top bar uses the same box at 32px height.
- Silkscreen is bundled with the client under its open font license. No Nintendo assets.

## Out of scope

Phone approvals, the delivery loop (why goals end blocked), a new map, and HQ Configure layout.

## Errors

- `project remove` unknown id: "No project <id>".
- Task pause on a task with no running job: marks it held, no error.
- Task chat when the agent no longer exists: opens the Manager and says so in the first line.

## Testing

- Board store: `held` column; held tasks skipped by the tick; resume.
- CLI: `project remove` drops rows, worktrees and branches, keeps the folder; refuses an unknown id.
- Protocol: `session.new` with `taskId` and `goalId`; task action `pause` and `resume`; inbox kinds.
- Client: list rows and counts; level 2 sections sort tasks by status; level 3 renders the four block kinds and follows new rows; Back keeps the level; Chat opens the dock with the right agent and title; the Inbox count covers five kinds; Delete asks first; style tokens apply.
