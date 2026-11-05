import { z } from "zod";
import type { Tool } from "@agentcity/core";
import { BoardError, type BoardStore } from "@agentcity/safety";

/** What one goal job may do on the board. `taskId` is the team task of a split job, or the worker task of a work or review job. */
export interface BoardToolCtx {
  board: BoardStore;
  goalId: string;
  taskId?: string;
  agentId: string;
  role: "boss" | "manager" | "worker";
  /** Boss: the managers. Manager: its team. Assignees outside this list are refused. */
  allowedAssignees: string[];
  /** The agent that reviews the task in `taskId`. The boss reviews when a project has no manager. */
  reviewer?: string;
  onChange(): void;
  onQuestion(taskId: string, question: string): void;
  /** Called with the error text of each create_task call the tool refuses, before the error returns. */
  onRejected?: (text: string) => void;
}

/** Turns a refused board write into text the model reads. Other errors are rethrown. */
function guard(fn: () => string): string {
  try {
    return fn();
  } catch (err) {
    if (err instanceof BoardError) return `error: ${err.message}`;
    throw err;
  }
}

const CreateTaskArgs = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  assignee: z.string().min(1).optional(),
  deps: z.array(z.string()).max(20).optional(),
  parallel: z.boolean().optional().describe("true when this task can run at the same time as the one before it"),
});
type CreateTaskArgs = z.infer<typeof CreateTaskArgs>;

/** Boss makes team tasks for managers. A manager makes worker tasks under its team task. Workers may not. */
export function makeCreateTaskTool(ctx: BoardToolCtx): Tool<CreateTaskArgs> {
  return {
    name: "create_task",
    description: ctx.role === "boss"
      ? "Create a team task for a manager. Give a title, a description with acceptance criteria, and an optional assignee (a manager id)."
      : "Create a worker task under your team task. Give a title, a description with acceptance criteria, an assignee (a team member id), and optional deps (task ids).",
    tier: 0,
    schema: CreateTaskArgs,
    async run(args) {
      const out = guard(() => {
        if (ctx.role === "worker") return "error: workers cannot create tasks";
        const parentId = ctx.role === "boss" ? null : (ctx.taskId ?? null);
        if (parentId === null && ctx.role === "manager") return "error: a manager needs its team task to create worker tasks";
        if (args.assignee !== undefined && ctx.allowedAssignees.length === 0) {
          return "error: this project has no workers; ask the player to grant one";
        }
        if (args.assignee !== undefined && !ctx.allowedAssignees.includes(args.assignee)) {
          return `error: assignee must be one of ${ctx.allowedAssignees.join(", ")}`;
        }
        const assignee = args.assignee ?? ctx.allowedAssignees[0] ?? null;
        // Plan steps run in order: a boss team task with no deps waits for the goal's previous team task, unless parallel.
        const previous = ctx.role === "boss" ? ctx.board.tasks(ctx.goalId).filter((t) => t.parentId === null).at(-1) : undefined;
        const chained = previous !== undefined && !args.parallel && (args.deps ?? []).length === 0 ? [previous.id] : args.deps;
        const task = ctx.board.createTask({
          goalId: ctx.goalId, parentId, title: args.title, description: args.description,
          assignee, deps: chained, createdBy: ctx.agentId,
        });
        ctx.board.rollup(ctx.goalId);
        ctx.onChange();
        return `created ${task.id}`;
      });
      if (out.startsWith("error: ")) ctx.onRejected?.(out);
      return out;
    },
  };
}

const UpdateTaskArgs = z.object({
  task_id: z.string().min(1),
  status: z.enum(["review", "blocked", "doing"]),
  summary: z.string().max(1000).optional(),
  blocked_reason: z.string().max(1000).optional(),
});
type UpdateTaskArgs = z.infer<typeof UpdateTaskArgs>;

/** A worker moves its own task. The reviewer of a task in review may send it back to doing. */
export function makeUpdateTaskTool(ctx: BoardToolCtx): Tool<UpdateTaskArgs> {
  return {
    name: "update_task",
    description: "Set a task's status: review when the work is done, blocked with blocked_reason when you cannot finish, doing to send it back. Add a summary.",
    tier: 0,
    schema: UpdateTaskArgs,
    async run(args) {
      return guard(() => {
        const task = ctx.board.task(args.task_id);
        if (!task) return `error: unknown task ${args.task_id}`;
        const mine = task.assignee === ctx.agentId;
        const reviewing = task.status === "review" && task.id === ctx.taskId && ctx.reviewer === ctx.agentId;
        if (!mine && !reviewing) return `error: ${task.id} is not yours`;
        // A job moves only its own task: a status set on another task would leave it with no job behind it.
        if (ctx.taskId !== undefined && task.id !== ctx.taskId) return `error: you work on ${ctx.taskId} only`;
        if (args.status === "blocked" && !args.blocked_reason) return "error: blocked needs blocked_reason";
        ctx.board.setStatus(task.id, args.status);
        ctx.board.update(task.id, {
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
          ...(args.blocked_reason !== undefined ? { blockedReason: args.blocked_reason } : {}),
        });
        ctx.board.rollup(task.goalId);
        ctx.onChange();
        return `updated ${task.id}`;
      });
    },
  };
}

const RequestMergeArgs = z.object({
  task_id: z.string().min(1),
  summary: z.string().min(1).max(1000),
});
type RequestMergeArgs = z.infer<typeof RequestMergeArgs>;

/** The reviewer of a task passes it on to the player. Only the reviewer may call it. */
export function makeRequestMergeTool(ctx: BoardToolCtx): Tool<RequestMergeArgs> {
  return {
    name: "request_merge",
    description: "Pass a reviewed task to the player for merge. Give a summary the player can read.",
    tier: 0,
    schema: RequestMergeArgs,
    async run(args) {
      return guard(() => {
        if (ctx.reviewer !== ctx.agentId || args.task_id !== ctx.taskId) return `error: you review ${ctx.taskId ?? "no task"} only`;
        const task = ctx.board.setStatus(args.task_id, "approval");
        ctx.board.update(task.id, { summary: args.summary });
        ctx.board.rollup(ctx.goalId);
        ctx.onChange();
        return `merge requested for ${task.id}`;
      });
    },
  };
}

const AskPlayerArgs = z.object({
  question: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(200)).max(6).optional(),
});
type AskPlayerArgs = z.infer<typeof AskPlayerArgs>;

/** Blocks the current task until the player answers. The question becomes the blocked reason. */
export function makeAskPlayerTool(ctx: BoardToolCtx): Tool<AskPlayerArgs> {
  return {
    name: "ask_player",
    description: "Ask the player one short question about a decision only the player can make. The task waits for the answer. Give options when you can.",
    tier: 0,
    schema: AskPlayerArgs,
    async run(args) {
      return guard(() => {
        if (!ctx.taskId) return "error: ask_player needs a task to wait on";
        const text = args.options?.length ? `${args.question} Options: ${args.options.join(" / ")}` : args.question;
        ctx.board.setStatus(ctx.taskId, "blocked");
        ctx.board.update(ctx.taskId, { blockedReason: text });
        ctx.board.rollup(ctx.goalId);
        ctx.onChange();
        ctx.onQuestion(ctx.taskId, text);
        return "asked the player; the task waits for the answer";
      });
    },
  };
}

const ProposePlanArgs = z.object({
  text: z.string().min(1).max(4000),
});
type ProposePlanArgs = z.infer<typeof ProposePlanArgs>;

/** The boss posts the plan for a goal that is still planning. The player answers it. */
export function makeProposePlanTool(ctx: BoardToolCtx): Tool<ProposePlanArgs> {
  return {
    name: "propose_plan",
    description: "Post the plan for the goal in plain text with three parts: Steps, Teams and Open questions. The player approves it or asks for changes.",
    tier: 0,
    schema: ProposePlanArgs,
    async run(args, runCtx) {
      const posted = { ok: false };
      const text = guard(() => {
        ctx.board.proposePlan(ctx.goalId, ctx.agentId, args.text);
        ctx.onChange();
        posted.ok = true;
        return `plan posted for ${ctx.goalId}. End your turn; the player answers it.`;
      });
      // A refused plan leaves the run open, so the boss can post a corrected one.
      if (posted.ok) runCtx.endRun?.();
      return text;
    },
  };
}

export type PostGoal = (project: string, text: string) => { ok: true; goalId: string } | { ok: false; error: string };

const CreateGoalArgs = z.object({
  project: z.string().min(1).max(100),
  text: z.string().min(1).max(2000),
});
type CreateGoalArgs = z.infer<typeof CreateGoalArgs>;

/** Posts a goal to an existing project. Tier 1, so the player approves it. */
export function makeCreateGoalTool(post: PostGoal): Tool<CreateGoalArgs> {
  return {
    name: "create_goal",
    description: "Post a new goal for a project. The boss plans it into tasks and the team does the work.",
    tier: 1,
    schema: CreateGoalArgs,
    async run(args) {
      const r = post(args.project, args.text);
      return r.ok ? `created ${r.goalId}` : `error: ${r.error}`;
    },
  };
}
