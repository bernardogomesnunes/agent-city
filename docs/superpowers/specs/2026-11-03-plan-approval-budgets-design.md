# Plan approval and job budgets

Batch 1 of the work after sub-project A. Two changes ship together on `feat/plan-approval`.

1. Every goal stops for the player's OK before any team task exists.
2. Budgets limit each job and each day. The lifetime project cap goes away.

## Why

Goal g2 on gamenew ("Have the game ready for general availability") ran with no sign-off. The boss created 5 team tasks t3 to t7 without asking a question. Then 4 of them stopped with "run stopped: budget", because the `usage` table counts tokens for the life of the project. gamenew passed 200,000 tokens and every later run stopped at once, although `claude-sub` costs $0.

## Part 1: plan approval

### Data

- `goals` gets two columns, added with `ALTER TABLE` when missing:
  - `plan TEXT` (max 4000 characters, redacted like task notes).
  - `plan_state TEXT NOT NULL DEFAULT 'none'`, one of `none`, `proposed`, `approved`.
- A goal created before this change reads as `plan_state = 'approved'` when it already has tasks, so old goals keep running.
- The player's change requests are goal notes: a new table `goal_notes (id, goal_id, text)`, taken (read and deleted) by the next plan job, like `task_notes`.

### Flow

1. A new goal starts in status `planning`, `plan_state = 'none'`. This holds for goals from the city and from chat (`create_goal`).
2. The scheduler runs a `plan` job for the boss. The job has `propose_plan {text}` and no `create_task`.
3. The plan prompt asks for three parts in plain text: Steps, Teams (which manager does what), Open questions. It includes the previous plan and the player's notes when they exist.
4. `propose_plan` stores the text and sets `plan_state = 'proposed'`. A second call in the same job replaces the text.
5. The J queue shows a decision of the new kind `plan`, id `p:<goalId>`, title "Plan: <goal text>", text = the plan.
6. The player answers with one of three buttons:
   - Approve: `plan_state = 'approved'`. The scheduler runs a `tasks` job for the boss.
   - Request changes: the box text (required, max 4000) becomes a goal note. `plan_state = 'none'`, so the scheduler runs the plan job again.
   - Reject: the goal becomes `cancelled`.
7. The `tasks` job gets the approved plan in its prompt and `create_task`, with today's plan rules (one team task per manager, acceptance criteria). After it the board runs as today: split, work, review.

### Edge cases

- A plan job that ends without `propose_plan` marks the goal `failed`, as an empty plan does today.
- A `tasks` job that creates no team task marks the goal `failed`.
- A restart keeps a `proposed` plan in the J queue. A goal in `none` gets its plan job again. A goal in `approved` with no tasks gets its `tasks` job again.
- A project with no boss keeps today's path (`scheduler.ts:301`): one task for the goal, no plan, no approval.
- Answering a plan that is no longer `proposed` returns an error reply ("plan is not waiting"), which the J panel shows through `setError`.

### Protocol and client

- `DecisionView.kind` adds `plan`, and `DecisionView` gets an optional `goalId`.
- New client message `plan.answer {goalId, option: "approve" | "changes" | "reject", text?}`. Server reply: the existing `review.result`-style result with `goalId`.
- The J panel shows the plan text in the decision body and the buttons Approve, Request changes, Reject, Skip. Request changes with an empty box sends nothing.
- The board shows a goal with `plan_state = 'proposed'` as "waiting for your OK".
- The boss walks to the podium for a plan decision, as for other decisions.

## Part 2: job budgets

### Rules

- Each job (plan, tasks, split, work, review, followup, chat turn) has a token cap, default 200,000. The run stops with reason `budget_job` when its own tokens reach the cap. The next job starts at 0.
- Each project has a daily dollar cap, default $1. Runs stop with reason `budget_day` when the project's spend for the current local day reaches it. The day resets at local midnight.
- Models with the `lmstudio/` or `claude-sub/` prefix skip both caps, since neither is billed per call. Their tokens are still recorded.
- A cap set to 0 means no cap.
- The lifetime project cap (`budget.maxTokens`, `budget.maxUsd`) and the per-agent cap (`perAgent.maxUsd`) are removed. The run tree dollar cap (`delegation.maxTreeUsd`) is removed with them, since the job token cap replaces it.
- Chats without a project use the same two caps, with the daily dollar cap counted under project "".

### Config

- `budget` becomes `{ jobTokens: number, dayUsd: number }`, defaults 200000 and 1.
- Loading an old config drops `maxTokens`, `maxUsd` and `perAgent`, and fills in the defaults. The file is rewritten in the new shape on the next save.
- CLI: `agentcity project budget <id> <jobTokens> <dayUsd>`.
- HQ settings: each project row shows "job 200k tokens · $1/day" and a Budget button with two number fields and Save, which runs the CLI command like the Edits button does.

### Storage

- New table `usage_days (project_id, day, tokens, usd, PRIMARY KEY (project_id, day))`, day as `YYYY-MM-DD` local time.
- The `usage` table stays as the lifetime record for display. Nothing reads it to stop a run.
- Job tokens live in the run's `RunTree`, which already exists per run: `addTokens(n)` and `tokens`.

### Messages

- `run stopped: budget_job` reads "stopped: this job used its 200,000 tokens. Answer to continue with a new job."
- `run stopped: budget_day` reads "stopped: the project spent its $1 for today."
- A stopped task stays in the J queue as today, so answering it starts a followup job with a fresh token count.

## Testing

- Board store: plan columns, `goal_notes`, old goals read as approved.
- Scheduler: goal waits at `proposed` and runs no split; Approve runs `tasks` then split; Request changes reruns plan with the note; Reject cancels; restart in each `plan_state`.
- Decisions: `plan` kind listed with goalId; `plan.answer` errors when not proposed.
- Gate: job cap stops at the cap; day cap stops and resets the next day; `lmstudio/` skips both; 0 disables a cap.
- Config: old shape loads with defaults; CLI command saves the new shape.
- Client: J panel plan buttons and empty Request changes; HQ settings Budget form.

## Out of scope

- Editing the plan text by hand in the panel.
- Per-provider price tables or monthly caps.
