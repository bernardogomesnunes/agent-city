import { z } from "zod";
import { AGENT_BUILDINGS, PLOT_KINDS } from "./map.js";

const BuildingIdSchema = z.enum([
  "director", "hq", "software", "visual",
  "plot-1", "plot-2", "plot-3", "plot-4", "plot-5", "plot-6",
]);
const ActivitySchema = z.enum([
  "idle", "thinking", "reading", "writing", "messaging", "delegating",
  "remembering", "building", "waiting_approval", "stopped",
]);

export const AgentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["boss", "manager", "worker"]),
  building: z.enum(AGENT_BUILDINGS),
  /** The agent's model id. The server always sends it. */
  model: z.string().optional(),
  activity: ActivitySchema,
  buildingId: BuildingIdSchema,
  projectId: z.string().optional(),
  runId: z.string().optional(),
  lastText: z.string().optional(),
});
export const PlotViewSchema = z.object({
  id: z.custom<`plot-${number}`>((v) => typeof v === "string" && /^plot-\d+$/.test(v)),
  kind: z.enum(PLOT_KINDS).optional(),
  builtBy: z.string().optional(),
});
export const ApprovalViewSchema = z.object({
  id: z.number(),
  projectId: z.string(),
  agentId: z.string(),
  tool: z.string(),
  argsPreview: z.string(),
  tier: z.number(),
  estimatedUsd: z.number(),
  local: z.boolean(),
});
/** One thing that waits on the player: an approval, a blocked task with its reason, or the merge of a task. */
export const DecisionViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["approval", "blocked", "merge", "plan"]),
  projectId: z.string(),
  agentId: z.string(),
  taskId: z.string().optional(),
  goalId: z.string().optional(),
  approvalId: z.number().optional(),
  title: z.string(),
  text: z.string(),
  since: z.string(),
});
/** A top run in progress, for the progress panel. */
export const RunViewSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  agentId: z.string(),
  goal: z.string(),
  startedAt: z.string(),
  steps: z.number(),
  /** Agents working under this run, the top agent first. */
  agents: z.array(z.string()),
  lastTool: z.string().optional(),
  lastText: z.string().optional(),
  usd: z.number(),
});
export const CityStateSchema = z.object({
  agents: z.array(AgentViewSchema),
  plots: z.array(PlotViewSchema),
  approvals: z.array(ApprovalViewSchema),
  runs: z.array(RunViewSchema).default([]),
});

/** Everything the HQ settings tabs show. Secret values never appear; only whether a key is stored. */
export const HqConfigSchema = z.object({
  projects: z.array(z.object({
    id: z.string(), agents: z.array(z.string()), workspace: z.string().optional(), edits: z.string(), mcp: z.array(z.string()),
    /** Tokens one job may use and dollars the project may spend per day. 0 means no cap. */
    budget: z.object({ jobTokens: z.number(), dayUsd: z.number() }),
    /** The limits: stepsPerJob and parallelJobs, 0 means no limit. The four retry counts are tries. */
    limits: z.object({
      stepsPerJob: z.number(), parallelJobs: z.number(), reminders: z.number(), testFixes: z.number(), sendBacks: z.number(), conflicts: z.number(),
    }),
    /** The branch agent work merges into, for a linked git folder. */
    base: z.string().optional(),
    /** agent/* branches with work the base lacks. */
    branches: z.array(z.object({
      name: z.string(), ahead: z.number(), subject: z.string(), date: z.string(), stat: z.string(),
    })).default([]),
  })),
  agents: z.array(z.object({
    id: z.string(), name: z.string(), role: z.string(), model: z.string(), persona: z.string(), building: z.string(),
    skills: z.array(z.string()), version: z.number(),
  })),
  connections: z.array(z.object({ name: z.string(), baseUrl: z.string(), hasKey: z.boolean() })),
  /** LM Studio's server address and whether its key is saved (the secret lmstudio). */
  lmStudio: z.object({ baseUrl: z.string(), hasKey: z.boolean() }),
  mcpServers: z.array(z.object({
    name: z.string(), where: z.string(), allow: z.array(z.string()), oauth: z.boolean(), signedIn: z.boolean(),
  })),
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
  secrets: z.array(z.string()),
  /** The Claude subscription: where claude is, and whether a sign-in is saved (null: cannot tell). */
  claude: z.object({ path: z.string().nullable(), signedIn: z.boolean().nullable(), text: z.string() }).default({ path: null, signedIn: false, text: "not installed" }),
});
export type HqConfig = z.infer<typeof HqConfigSchema>;

/** Numbers for the HQ Work view, over the last 7 days. */
export const HqStatsSchema = z.object({
  days: z.array(z.object({ day: z.string(), runs: z.number(), usd: z.number() })),
  runs: z.number(),
  /** Top runs that stopped with reason "done". */
  done: z.number(),
  usd: z.number(),
  tools: z.number(),
  approvals: z.object({ approved: z.number(), denied: z.number(), pending: z.number() }),
  perAgent: z.array(z.object({ agentId: z.string(), runs: z.number(), done: z.number(), usd: z.number(), tools: z.number() })),
  activity: z.array(z.object({ ts: z.string(), agentId: z.string(), projectId: z.string(), kind: z.string(), text: z.string() })),
});
export type HqStats = z.infer<typeof HqStatsSchema>;

/** Models one source offers. `error` says why the list is empty. */
export const ModelGroupSchema = z.object({ label: z.string(), models: z.array(z.string()), error: z.string().optional() });
export type ModelGroup = z.infer<typeof ModelGroupSchema>;

/** One line of a session thread. */
export const SessionMessageSchema = z.object({
  id: z.number(), sessionId: z.number(), ts: z.string(), kind: z.enum(["user", "agent", "report", "system"]),
  author: z.string(), text: z.string(), status: z.enum(["queued", "running", "done"]),
});
export type SessionMessageView = z.infer<typeof SessionMessageSchema>;
/** A session in the list: working (its turn runs), queued (runs, more wait), waiting (another tree holds the project), idle. */
export const SessionViewSchema = z.object({
  id: z.number(), projectId: z.string().optional(), agentId: z.string(), title: z.string(),
  status: z.enum(["idle", "working", "queued", "waiting"]), queued: z.number(), last: z.string(), lastTs: z.string(),
  /** The task or goal the chat is about, null for a plain chat. */
  taskId: z.string().nullable().optional(), goalId: z.string().nullable().optional(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

/** One file or folder of a file tree. Paths are relative to the tree root. */
export const FileEntrySchema = z.object({ path: z.string(), size: z.number(), dir: z.boolean() });
export type FileEntry = z.infer<typeof FileEntrySchema>;
export const FileTreeSchema = z.object({ entries: z.array(FileEntrySchema), truncated: z.boolean(), error: z.string().optional() });
export type FileTree = z.infer<typeof FileTreeSchema>;

export const TaskStatusSchema = z.enum(["todo", "doing", "review", "approval", "done", "blocked", "cancelled"]);
export const GoalStatusSchema = z.enum(["planning", "active", "done", "cancelled", "failed"]);
/** A goal with its worker task progress. */
export const GoalViewSchema = z.object({
  id: z.string(), projectId: z.string(), text: z.string(), status: GoalStatusSchema, createdAt: z.string(), updatedAt: z.string(),
  done: z.number(), total: z.number(),
  planState: z.enum(["none", "proposed", "approved"]), plan: z.string().nullable(),
});
export type GoalView = z.infer<typeof GoalViewSchema>;
/** A task as the client sees it: every field except the scheduler's counters. */
export const TaskViewSchema = z.object({
  id: z.string(), goalId: z.string(), parentId: z.string().nullable(), projectId: z.string(),
  title: z.string(), description: z.string(), assignee: z.string().nullable(), deps: z.array(z.string()),
  status: TaskStatusSchema, branch: z.string().nullable(), worktree: z.string().nullable(),
  summary: z.string().nullable(), blockedReason: z.string().nullable(),
  ci: z.enum(["none", "running", "pass", "fail"]), testOutput: z.string().nullable(),
  checkpoint: z.string().nullable(), held: z.boolean(),
  createdBy: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;
/** One line of a task log. */
export const LogRowSchema = z.object({
  ts: z.string(), agentId: z.string(), kind: z.enum(["text", "tool", "result", "error"]), text: z.string(),
});
export type LogRow = z.infer<typeof LogRowSchema>;
export const DiffLineSchema = z.object({
  kind: z.enum(["add", "del", "ctx"]), text: z.string(), oldNo: z.number().optional(), newNo: z.number().optional(),
});
export const DiffFileSchema = z.object({
  path: z.string(), status: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
  additions: z.number(), deletions: z.number(), hunks: z.array(z.array(DiffLineSchema)), truncated: z.boolean(),
});
export type DiffFileView = z.infer<typeof DiffFileSchema>;

export type AgentView = z.infer<typeof AgentViewSchema>;
export type PlotView = z.infer<typeof PlotViewSchema>;
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;
export type DecisionView = z.infer<typeof DecisionViewSchema>;
export type RunView = z.infer<typeof RunViewSchema>;
export type CityState = z.infer<typeof CityStateSchema>;

export const ServerMsgSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), state: CityStateSchema }),
  z.object({
    type: z.literal("patch"),
    agents: z.array(AgentViewSchema).optional(),
    plots: z.array(PlotViewSchema).optional(),
    approvals: z.array(ApprovalViewSchema).optional(),
    runs: z.array(RunViewSchema).optional(),
  }),
  z.object({ type: z.literal("term.out"), text: z.string() }),
  z.object({ type: z.literal("term.done"), code: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("models"), groups: z.array(ModelGroupSchema) }),
  z.object({ type: z.literal("agent.saved"), agentId: z.string(), version: z.number() }),
  z.object({ type: z.literal("hq.config"), config: HqConfigSchema }),
  /** The result of one HQ form action. `text` is the command output. */
  z.object({ type: z.literal("hq.done"), id: z.string(), code: z.number(), text: z.string() }),
  /** Open this address to sign in to an MCP server. */
  z.object({ type: z.literal("hq.signin"), server: z.string(), url: z.string() }),
  z.object({ type: z.literal("hq.stats"), stats: HqStatsSchema }),
  /** Local ports that answer HTTP, for the software house preview. */
  z.object({ type: z.literal("ports"), list: z.array(z.object({ port: z.number(), title: z.string() })) }),
  z.object({ type: z.literal("session.list"), sessions: z.array(SessionViewSchema) }),
  /** The latest messages of one session, oldest first. */
  z.object({ type: z.literal("session.thread"), sessionId: z.number(), messages: z.array(SessionMessageSchema) }),
  /** One new or changed message, sent to every tab. */
  z.object({ type: z.literal("session.msg"), message: SessionMessageSchema }),
  /** The goals and tasks of a watched project. Sent on `board.watch` and after every change. */
  z.object({ type: z.literal("board"), projectId: z.string(), goals: z.array(GoalViewSchema), tasks: z.array(TaskViewSchema) }),
  /** An opened task. `previewKey` and `hasIndex` belong to the preview route `/p/<previewKey>/<taskId>/`. */
  z.object({
    type: z.literal("task.detail"), task: TaskViewSchema, log: z.array(LogRowSchema), files: FileTreeSchema,
    previewKey: z.string(), hasIndex: z.boolean(),
  }),
  /** New log rows of the task a client has open. */
  z.object({ type: z.literal("task.log"), taskId: z.string(), rows: z.array(LogRowSchema) }),
  z.object({ type: z.literal("diff"), taskId: z.string(), files: z.array(DiffFileSchema) }),
  /** One file of a task's folder, for the Files tab. */
  z.object({
    type: z.literal("file"), taskId: z.string(), path: z.string(), text: z.string().optional(), binary: z.boolean(),
    truncated: z.boolean(), error: z.string().optional(),
  }),
  /** The decisions that wait on the player, oldest first, and the agents with failing CI. */
  z.object({ type: z.literal("decisions"), list: z.array(DecisionViewSchema), failing: z.array(z.string()) }),
  z.object({ type: z.literal("review.result"), taskId: z.string(), ok: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal("plan.result"), goalId: z.string(), ok: z.boolean(), error: z.string().optional() }),
  /** The ids of the paused projects. Sent on connect and after every change. */
  z.object({ type: z.literal("paused"), projectIds: z.array(z.string()) }),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;

const ClientBaseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"), id: z.number(), decision: z.enum(["approved", "denied"]) }),
  z.object({ type: z.literal("run"), projectId: z.string(), agentId: z.string(), goal: z.string() }),
  z.object({ type: z.literal("term.in"), line: z.string() }),
  z.object({ type: z.literal("models.list") }),
  z.object({ type: z.literal("agent.model"), agentId: z.string(), model: z.string().min(1).max(200) }),
  z.object({ type: z.literal("hq.config") }),
  /** Runs one allowed agentcity command for an HQ form. `input` answers a hidden prompt, such as a key. */
  z.object({ type: z.literal("hq.do"), id: z.string().max(40), argv: z.array(z.string().max(8000)).min(1).max(40), input: z.string().max(8000).optional() }),
  z.object({ type: z.literal("run.stop"), projectId: z.string() }),
  z.object({ type: z.literal("ports.scan") }),
  z.object({ type: z.literal("hq.stats") }),
  /** A new chat with an agent, with a project or without. */
  z.object({
    type: z.literal("session.new"), agentId: z.string().max(100), projectId: z.string().max(100).optional(),
    /** Opens the chat about this task or goal. */
    taskId: z.string().max(100).optional(), goalId: z.string().max(100).optional(),
  }),
  z.object({ type: z.literal("goal.submit"), projectId: z.string().max(100), text: z.string().min(1).max(2000) }),
  /** Starts the `board` messages for a project. */
  z.object({ type: z.literal("board.watch"), projectId: z.string().max(100) }),
  z.object({ type: z.literal("task.open"), taskId: z.string().max(100) }),
  z.object({ type: z.literal("task.message"), taskId: z.string().max(100), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("task.action"), taskId: z.string().max(100), action: z.enum(["retry", "cancel", "rollback", "pause", "resume"]) }),
  z.object({ type: z.literal("project.pause"), projectId: z.string().max(100), paused: z.boolean() }),
  /** Stop all (true) or resume all (false). */
  z.object({ type: z.literal("city.pause"), paused: z.boolean() }),
  /** The answer to an `ask_player` question. */
  z.object({ type: z.literal("task.answer"), taskId: z.string().max(100), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("review.answer"), taskId: z.string().max(100), option: z.enum(["merge", "changes", "reject"]), text: z.string().max(4000).optional() }),
  z.object({ type: z.literal("plan.answer"), goalId: z.string().max(100), option: z.enum(["approve", "changes", "reject"]), text: z.string().max(4000).optional() }),
  z.object({ type: z.literal("diff.request"), taskId: z.string().max(100) }),
  z.object({ type: z.literal("file.request"), taskId: z.string().max(100), path: z.string().min(1).max(1000) }),
]);
/**
 * The chat messages come in two forms. `sessionId` names a chat. The older pair form (`projectId`, `agentId`)
 * stays until the client switches: it means the newest chat of that pair.
 */
const ChatMsgSchema = z.union([
  z.object({ type: z.literal("session.send"), sessionId: z.number().int(), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("session.send"), projectId: z.string().max(100), agentId: z.string().max(100), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("session.open"), sessionId: z.number().int() }),
  z.object({ type: z.literal("session.open"), projectId: z.string().max(100), agentId: z.string().max(100) }),
]);

export const ClientMsgSchema = z.union([ClientBaseSchema, ChatMsgSchema]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

export function parseClientMsg(raw: string): ClientMsg | null {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return null; }
  const r = ClientMsgSchema.safeParse(json);
  return r.success ? r.data : null;
}
