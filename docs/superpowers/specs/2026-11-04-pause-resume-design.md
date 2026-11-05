# Pause, resume and checkpoints

Sub-project B of the orchestrator gap list. Branch `feat/pause-resume`.

## Why

Agent City has Cancel and Retry per task and nothing else. A player who sees tokens running away can only cancel tasks one by one. A job stopped by a restart or a crash starts again from scratch: the worktree stays, but the new run gets no word of what the old run did. A bad run cannot be undone short of cancelling the task.

## Scope

1. Pause and Resume per project.
2. Stop all: pause every project at once. Resume all undoes it.
3. A resume note: a job that follows a stopped run gets a short list of what that run did.
4. Checkpoints: Roll back returns a task's worktree to where it was before its last run.

Pause per goal is out of scope.

## Part 1: pause

### Data

- New table `paused_projects (project_id TEXT PRIMARY KEY, since TEXT NOT NULL)`. A row means paused. It survives a restart.
- `BoardStore.setPaused(projectId, paused: boolean)`, `BoardStore.paused(): string[]`.

### Scheduler

- `Scheduler.pause(projectId)`:
  1. Writes the row.
  2. Drops the project's queued items.
  3. Aborts each running board job of the project with a new stop kind `"pause"`.
- An aborted run with stop `"pause"` ends like the shutdown path (stop `"stop"`): `after()` returns at once. Then the scheduler runs `recover()` for that project only, so a worker task in `doing` goes back to `todo` with its worktree kept, and a task in `review` moves to `approval`. Its waiting approvals are denied, as on any abort today.
- The tick skips a paused project: no plan, tasks, split, work, review or followup job starts. Chat turns with agents still run.
- `Scheduler.resume(projectId)` deletes the row and ticks.
- `Scheduler.pauseAll()` pauses every project. `Scheduler.resumeAll()` resumes every paused project.
- Answering a decision in a paused project still records the answer (`task.answer`, `review.answer`, `plan.answer`). The job it would start waits for Resume. A merge runs at once, since it starts no agent.

### Protocol

- `ClientMsg`: `project.pause {projectId, paused: boolean}` and `city.pause {paused: boolean}`.
- `ServerMsg`: `paused {projectIds: string[]}`, sent to every client on connect and after each change.

### Client

- The building panel's board header shows Pause or Resume for its project. A paused project shows the tag "paused".
- The HUD top bar gets a Stop all button. While any project is paused it reads Resume all.
- The board shows the goals of a paused project as they are, with the tag on the project header.

## Part 2: resume note

- When the scheduler builds a work or followup job for a task, it looks at the task's last run (`board.runs(taskId)`, newest).
- When that run's `run.stopped` row has a reason other than `done`, or the run has no `run.stopped` row (the city stopped mid-run), the prompt gets a note:

  ```
  Your last run on this task stopped (<reason>, or "the city stopped"). It did:
  - <tool> <first string arg>
  ...
  Check the worktree before you redo anything.
  ```

- The list holds the last 15 `tool.requested` rows of that run, in order, each cut to 120 characters and redacted like the task log.
- `workPrompt` gets an optional `resume?: string` in its options. A followup prompt appends the same note.

## Part 3: checkpoints

### Data

- `tasks` gets `checkpoint TEXT` (a commit sha), added with `ALTER TABLE` when missing.

### Flow

1. Before a work or followup job starts, the scheduler commits any uncommitted changes in the worktree (`commitAll`, message `<taskId>: checkpoint`), then stores `HEAD` as `checkpoint`.
2. Roll back is a new task action `rollback`, allowed when the task has a checkpoint and no running job. It runs `git reset --hard <checkpoint>` and `git clean -fd` in the worktree, sets the task to `todo`, and clears `blockedReason`. The next job runs from the checkpoint with no resume note, since the work it would describe is gone.
3. A task whose checkpoint commit no longer exists (for example after a manual rebase) answers rollback with the error "checkpoint is gone".

### Client

- The task detail shows Roll back next to Retry and Cancel when the task has a checkpoint and is not running. A confirm line asks "Undo the last run's changes?".
- The decisions panel shows Roll back on a question decision of a worker task.

## Errors

- `project.pause` for an unknown project replies `error` "No project <id>".
- `rollback` on a running task replies "stop the task first". On a task with no checkpoint: "no checkpoint yet".

## Testing

- Board store: `paused_projects`, `checkpoint` column.
- Scheduler: pause aborts the running job, the task returns to `todo` with its worktree, and the tick starts nothing; resume runs it again; pauseAll and resumeAll; a plan answer in a paused project waits; a restart keeps the pause.
- Resume note: built from the last stopped run; absent after a `done` run; "the city stopped" when the run has no stop row; 15 rows at most.
- Checkpoints: stored before a work job; rollback resets files and the task; errors for running, missing and gone checkpoints.
- City server: `project.pause`, `city.pause`, `paused` broadcast.
- Client: Pause and Resume button, Stop all and Resume all, Roll back with confirm.
