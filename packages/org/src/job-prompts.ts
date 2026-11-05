import type { Goal, Task } from "@agentcity/safety";

export interface Member { id: string; name: string }

/** Rule lines for each job role. Each line stays under 25 words, so a small local model keeps them in view. */
export const JOB_RULES: Record<"boss" | "manager" | "worker", string> = {
  boss: [
    "For a new goal, post a plan with propose_plan. After the player approves, create team tasks with create_task.",
    "Give each team task a manager as assignee. Team tasks hold no code.",
    "Write acceptance criteria in each description. Do not write files or run commands.",
    "When the team has no manager, you split the work into worker tasks yourself with create_task.",
    "Call ask_player only for a decision that belongs to the player.",
  ].join("\n"),
  manager: [
    "You split one team task into worker tasks with create_task, then end your turn.",
    "Give each worker task an assignee from your team, acceptance criteria, and deps by task id.",
    "Keep each worker task small enough for one branch. Do not write code yourself.",
    "When asked to review, call request_merge if the work meets the task. Otherwise call update_task with status doing and the changes needed.",
  ].join("\n"),
  worker: [
    "Work only inside your worktree. Edit files and run the tests there.",
    "Never push, fetch, pull or switch branches. Git has no network access.",
    "When finished, call update_task with status review and a summary of the changes and tests.",
    "If you cannot finish, call update_task with status blocked and blocked_reason, then end your turn.",
    "Call ask_player only for a decision that belongs to the player.",
  ].join("\n"),
};

function chat(last: string): string {
  return [
    "You are in a chat with the player. Answer in plain text.",
    "You cannot write files or run commands here. Every change goes through a goal, a task and a review.",
    last,
  ].join("\n");
}

/** Rule lines for a plain chat turn. A chat reads files and remembers; changes go through goals. */
export const CHAT_RULES: Record<"boss" | "manager" | "worker", string> = {
  boss: chat("To start work on a project, call create_goal with the project id and the goal text."),
  manager: chat("To start work on a project, call create_goal with the project id and the goal text."),
  worker: chat("For a change, tell the player to ask the boss or a manager to post a goal."),
};

const DIFF_MAX = 12000;

function roster(members: Member[]): string {
  return members.map((m) => `${m.name} (${m.id})`).join(", ") || "(none)";
}

function boardText(board: Task[], members: Member[]): string {
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  if (board.length === 0) return "(no tasks yet)";
  return board
    .map((t) => `- ${t.id} [${t.status}] ${t.title}${t.assignee ? ` (${name(t.assignee)})` : ""}${t.deps.length ? ` deps: ${t.deps.join(", ")}` : ""}`)
    .join("\n");
}

/** Boss job: write a plan for a new goal in prose. `previous` and `notes` carry the last plan and the player's requested changes. */
export function planPrompt(goal: Goal, members: Member[], previous: string | null, notes: string[]): string {
  const last = previous === null ? "" : `\nYour last plan:\n${previous}\n`;
  const changes = notes.length ? `\nThe player asked for changes:\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "";
  return `New goal from the player for project ${goal.projectId}:
"${goal.text}"

Managers: ${roster(members)}
${last}${changes}
Write the plan as plain text with three parts headed Steps, Teams and Open questions. Post it with propose_plan. End your turn after it.`;
}

/** Boss job: split an approved plan into team tasks. */
export function tasksPrompt(goal: Goal, plan: string, board: Task[], members: Member[]): string {
  return `Goal ${goal.id} for project ${goal.projectId}: "${goal.text}"

The player approved this plan:
${plan}

Managers: ${roster(members)}
Goal board:
${boardText(board, members)}

Create one team task per part of the plan with create_task, each with a manager as assignee. Make one task per real piece of work. A small goal is one task. End your turn after the last one.`;
}

/** Manager job: split one team task into worker tasks. */
export function splitPrompt(goal: Goal, team: Task, board: Task[], members: Member[]): string {
  return `Team task ${team.id} "${team.title}" of goal ${goal.id}: "${goal.text}"
${team.description ? `\n${team.description}\n` : ""}
Your team: ${roster(members)}
Goal board:
${boardText(board, members)}

Split this team task into worker tasks with create_task. Give each an assignee from your team and acceptance criteria. A small task gets one worker task. End your turn after the last one.`;
}

/** Worker job: do one worker task in its worktree. */
export function workPrompt(
  goal: Goal,
  task: Task,
  board: Task[],
  opts: { worktree: string; branch: string; base: string; answers: string[]; inbox: string[]; continues: boolean; resume?: string },
): string {
  const earlier = opts.continues
    ? `This branch already has earlier work. See \`git log ${opts.base}..HEAD\` and continue from there.\n`
    : "";
  const answers = opts.answers.length
    ? `\nThe player answered these questions on this task:\n${opts.answers.map((a) => `- ${a}`).join("\n")}\n`
    : "";
  const inbox = opts.inbox.length ? `\nMessages from the player:\n${opts.inbox.join("\n")}\n` : "";
  const resume = opts.resume ? `\n${opts.resume}\n` : "";
  return `Your task: ${task.id} "${task.title}"
${task.description ? `\n${task.description}\n` : ""}
Goal: ${goal.text}
Worktree: ${opts.worktree} (branch ${opts.branch}, based on ${opts.base})
${earlier}${answers}${inbox}${resume}
Goal board:
${boardText(board, [])}

Your notes may be out of date. Run list_files first. The folder you are in is the task's work folder and holds the project.
Start now. When finished, call update_task with task_id ${task.id} and status review, and a summary.`;
}

/** Reviewer job: decide on a worker task that reached review. */
export function reviewPrompt(
  task: Task,
  summary: string,
  test: { command?: string; pass?: boolean; output?: string },
  diff: string,
): string {
  const result = test.pass === undefined ? "not run" : test.pass ? "PASS" : "FAIL";
  const output = test.pass === false && test.output ? `\nTest output (tail):\n${test.output}\n` : "";
  const cut = diff.length > DIFF_MAX ? `${diff.slice(0, DIFF_MAX)}\n[diff cut at ${DIFF_MAX} characters]` : diff;
  return `Review request: ${task.id} "${task.title}" by ${task.assignee ?? "unassigned"}.
Worker summary: ${summary}
Tests (${test.command ?? "none"}): ${result}
${output}
Diff vs base:
${cut}

Decide now. If the work meets the task, call request_merge with task_id ${task.id} and a summary for the player. Otherwise call update_task with task_id ${task.id}, status doing, and the changes needed. Then end your turn.`;
}

/** One reminder when a work job ends with its task still in doing. The task brief travels with it, so the job knows what to build. */
export function nudgePrompt(task: Task): string {
  return `Task ${task.id} "${task.title}" is still doing.
${task.description ? `\n${task.description}\n` : ""}
Your last turn ended with no result. Do the work now with your tools, then call update_task with status review. Use status blocked only if a tool call failed or the player must decide.`;
}
