import type { ActionLog, ActionRow, Task } from "@agentcity/safety";
import type { LogRow } from "@agentcity/world/shared";

/** The longest text of one log row. */
export const LOG_TEXT_MAX = 500;

const cut = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > LOG_TEXT_MAX ? `${one.slice(0, LOG_TEXT_MAX - 3)}...` : one;
};

function rowOf(r: ActionRow): Omit<LogRow, "text"> & { text: string } | null {
  const p = (r.payload ?? {}) as Record<string, unknown>;
  const base = { ts: r.ts, agentId: r.agentId };
  switch (r.type) {
    case "run.started":
      return { ...base, kind: "text", text: `started: ${typeof p.goal === "string" ? p.goal : ""}` };
    case "run.stopped": {
      const reason = String(p.reason ?? "");
      const detail = typeof p.detail === "string" && p.detail !== "" ? `: ${p.detail}` : "";
      return { ...base, kind: reason === "done" ? "text" : "error", text: `stopped: ${reason}${typeof p.steps === "number" ? `, ${p.steps} steps` : ""}${detail}` };
    }
    case "inbox":
      return { ...base, kind: "text", text: `${typeof p.count === "number" ? p.count : 1} message(s) from the player` };
    case "tool.requested": {
      const call = p.call as { name?: unknown; args?: unknown } | undefined;
      if (typeof call?.name !== "string") return null;
      const first = call.args && typeof call.args === "object"
        ? Object.values(call.args as Record<string, unknown>).find((v) => typeof v === "string")
        : undefined;
      return { ...base, kind: "tool", text: typeof first === "string" ? `${call.name} ${first}` : call.name };
    }
    case "tool.result": {
      const name = typeof p.name === "string" ? `${p.name} ` : "";
      const result = typeof p.result === "string" ? p.result : "";
      return { ...base, kind: p.outcome === "ok" ? "result" : "error", text: `${name}${String(p.outcome ?? "")}: ${result}` };
    }
    default:
      // model calls, usage and gate decisions stay out of the player's log
      return null;
  }
}

/** Action rows as log rows: redacted with `redactText`, then cut to 500 characters. Rows the player does not need are dropped. */
export function toLogRows(rows: ActionRow[], redactText: (s: string) => string): LogRow[] {
  const out: LogRow[] = [];
  for (const r of rows) {
    const row = rowOf(r);
    if (row) out.push({ ...row, text: cut(redactText(row.text)) });
  }
  return out;
}

/** The log of a task: the action rows of its runs after `afterId`, as rows the client shows. */
export function taskLog(log: ActionLog, runIds: string[], redactText: (s: string) => string, afterId = 0): LogRow[] {
  return toLogRows(log.ofRuns(runIds, afterId), redactText);
}

/** The tool rows a resume note lists, the last ones. */
export const RESUME_ROWS = 15;
/** The longest tool text in a resume note, the "..." included. */
export const RESUME_ROW_MAX = 120;

/**
 * What a task chat's first turn starts with: the task, then the last `RESUME_ROWS` log rows of its latest run, redacted and cut like a resume note.
 * `rows` are the task's log rows, oldest first. A run starts at a "started:" text row.
 */
export function taskContext(task: Task, rows: LogRow[], redactText: (s: string) => string): string {
  const start = rows.findLastIndex((r) => r.kind === "text" && r.text.startsWith("started:"));
  const lines = rows.slice(Math.max(start, 0)).slice(-RESUME_ROWS).map((r) => {
    const one = redactText(r.text).replace(/\s+/g, " ").trim();
    return `- ${one.length > RESUME_ROW_MAX ? `${one.slice(0, RESUME_ROW_MAX - 3)}...` : one}`;
  });
  return [
    `This chat is about task ${task.id}: ${task.title}`,
    `Description: ${redactText(task.description)}`,
    `Status: ${task.status}`,
    `Branch: ${task.branch ?? "none"}`,
    ...(lines.length > 0 ? ["Last log rows:", ...lines] : []),
  ].join("\n");
}

/**
 * What a run did before it stopped early: its last tool calls, redacted and cut.
 * Undefined after a done run. A run with no stop row reads as stopped by the city.
 */
export function resumeNote(rows: ActionRow[], redactText: (s: string) => string): string | undefined {
  if (rows.length === 0) return undefined;
  const stop = [...rows].reverse().find((r) => r.type === "run.stopped");
  const p = (stop?.payload ?? {}) as Record<string, unknown>;
  const reason = typeof p.reason === "string" && p.reason !== "" ? p.reason : "the city stopped";
  if (reason === "done") return undefined;
  const tools = rows.flatMap((r) => {
    const row = rowOf(r);
    return row?.kind === "tool" ? [row.text] : [];
  });
  const lines = tools.slice(-RESUME_ROWS).map((t) => {
    const one = redactText(t).replace(/\s+/g, " ").trim();
    const short = one.length > RESUME_ROW_MAX ? `${one.slice(0, RESUME_ROW_MAX - 3)}...` : one;
    return `- ${short}`;
  });
  return [`Your last run on this task stopped (${reason}). It did:`, ...lines, "Check the worktree before you redo anything."].join("\n");
}
