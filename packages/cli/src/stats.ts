import type Database from "better-sqlite3";
import type { HqStats } from "@agentcity/world/shared";
import { redact } from "@agentcity/safety";

const DAY_MS = 86_400_000;
const ACTIVITY_ROWS = 30;
const TEXT_MAX = 160;

interface Row { ts: string; project_id: string; agent_id: string; type: string; payload_json: string }

/** One line for the activity list, or null for rows it skips (model calls, usage). */
function activityText(r: Row): { kind: string; text: string } | null {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(r.payload_json) as Record<string, unknown>;
  } catch {
    // a broken payload still shows its type
  }
  switch (r.type) {
    case "run.started":
      return { kind: "start", text: `started: ${typeof p.goal === "string" ? p.goal : ""}` };
    case "run.stopped":
      return { kind: p.reason === "done" ? "done" : "stop", text: `stopped: ${String(p.reason ?? "")}${typeof p.steps === "number" ? `, ${p.steps} steps` : ""}` };
    case "tool.requested": {
      const call = p.call as { name?: unknown; args?: unknown } | undefined;
      if (typeof call?.name !== "string") return null;
      const args = call.args && typeof call.args === "object" ? Object.values(call.args as Record<string, unknown>).find((v) => typeof v === "string") : undefined;
      return { kind: "tool", text: typeof args === "string" ? `${call.name} ${args}` : call.name };
    }
    case "tool.result":
      return { kind: p.outcome === "ok" ? "ok" : "fail", text: `${String(p.outcome ?? "")}: ${typeof p.result === "string" ? p.result : ""}` };
    default:
      return null;
  }
}

/**
 * Numbers for the HQ Work view over the last `days` days: top runs, how many finished with "done",
 * spend, tool calls, approval answers, a per-day series, a per-agent table and the latest activity.
 * Every text that leaves goes through `redact` with the stored secrets.
 */
export function hqStats(db: Database.Database, secrets: string[], now = Date.now(), days = 7): HqStats {
  const since = new Date(now - days * DAY_MS).toISOString();
  const tops = db
    .prepare("SELECT run_id, agent_id, ts FROM actions WHERE type = 'run.started' AND parent_run_id IS NULL AND run_id IS NOT NULL AND ts >= ?")
    .all(since) as Array<{ run_id: string; agent_id: string; ts: string }>;
  const topIds = new Set(tops.map((t) => t.run_id));
  const stops = db
    .prepare("SELECT run_id, json_extract(payload_json, '$.reason') AS reason FROM actions WHERE type = 'run.stopped' AND ts >= ?")
    .all(since) as Array<{ run_id: string | null; reason: string | null }>;
  const done = new Set(stops.filter((s) => s.run_id && topIds.has(s.run_id) && s.reason === "done").map((s) => s.run_id!));
  const perAgentRows = db
    .prepare("SELECT agent_id, SUM(usd) AS usd, SUM(type = 'tool.requested') AS tools FROM actions WHERE ts >= ? GROUP BY agent_id")
    .all(since) as Array<{ agent_id: string; usd: number | null; tools: number | null }>;
  const answers = db
    .prepare("SELECT status, COUNT(*) AS n FROM approvals WHERE ts >= ? GROUP BY status")
    .all(since) as Array<{ status: string; n: number }>;
  const count = (s: string) => answers.find((a) => a.status === s)?.n ?? 0;

  const perAgent = new Map<string, { agentId: string; runs: number; done: number; usd: number; tools: number }>();
  const agent = (id: string) => {
    let a = perAgent.get(id);
    if (!a) perAgent.set(id, (a = { agentId: id, runs: 0, done: 0, usd: 0, tools: 0 }));
    return a;
  };
  for (const t of tops) {
    const a = agent(t.agent_id);
    a.runs++;
    if (done.has(t.run_id)) a.done++;
  }
  for (const r of perAgentRows) {
    const a = agent(r.agent_id);
    a.usd = r.usd ?? 0;
    a.tools = r.tools ?? 0;
  }

  const series: HqStats["days"] = [];
  for (let i = days - 1; i >= 0; i--) series.push({ day: new Date(now - i * DAY_MS).toISOString().slice(0, 10), runs: 0, usd: 0 });
  for (const t of tops) {
    const d = series.find((s) => s.day === t.ts.slice(0, 10));
    if (d) d.runs++;
  }
  const spendDays = db
    .prepare("SELECT substr(ts, 1, 10) AS day, SUM(usd) AS usd FROM actions WHERE ts >= ? GROUP BY day")
    .all(since) as Array<{ day: string; usd: number | null }>;
  for (const s of spendDays) {
    const d = series.find((x) => x.day === s.day);
    if (d) d.usd = s.usd ?? 0;
  }

  const recent = db
    .prepare("SELECT ts, project_id, agent_id, type, payload_json FROM actions WHERE type IN ('run.started', 'run.stopped', 'tool.requested', 'tool.result') ORDER BY id DESC LIMIT ?")
    .all(ACTIVITY_ROWS) as Row[];
  const activity: HqStats["activity"] = [];
  for (const r of recent) {
    const a = activityText(r);
    if (!a) continue;
    activity.push({ ts: r.ts, agentId: r.agent_id, projectId: r.project_id, kind: a.kind, text: redact(a.text.replace(/\s+/g, " ").trim(), secrets).slice(0, TEXT_MAX) });
  }

  return {
    days: series,
    runs: tops.length,
    done: done.size,
    usd: perAgentRows.reduce((s, r) => s + (r.usd ?? 0), 0),
    tools: perAgentRows.reduce((s, r) => s + (r.tools ?? 0), 0),
    approvals: { approved: count("approved"), denied: count("denied"), pending: count("pending") },
    perAgent: [...perAgent.values()].sort((a, b) => b.runs - a.runs || b.usd - a.usd),
    activity,
  };
}
