import type { Goal, Task } from "@agentcity/safety";
import type { ApprovalView, DecisionView } from "@agentcity/world/shared";

/** The most decisions the server lists. The rest wait until earlier ones leave. */
export const DECISIONS_MAX = 200;

/** The first-seen time of an approval the server has no record of. It sorts first. */
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface DecisionInput {
  approvals: ApprovalView[];
  /** The time the server first saw each approval id. */
  seen: Map<number, string>;
  /** The tasks of every project, as BoardStore.waitingTasks returns them. */
  tasks: Task[];
  /** The goals whose plan waits for the player, as BoardStore.plansWaiting returns them. */
  goals: Goal[];
  /** The ids of the goals with status active or planning. A blocked task of any other goal is not listed. */
  activeGoals: Set<string>;
}

/** A blocked task shows its reason, a task in approval is a merge. The waiting agent is the assignee, or the creator without one. */
function ask(t: Task, kind: "blocked" | "merge"): DecisionView {
  return {
    id: `${kind === "blocked" ? "b" : "m"}:${t.id}`,
    kind,
    projectId: t.projectId,
    agentId: t.assignee ?? t.createdBy,
    taskId: t.id,
    title: t.title,
    text: kind === "blocked" ? (t.blockedReason ?? "") : (t.summary ?? ""),
    since: t.updatedAt,
  };
}

/** Oldest `since` first, ties by id. ISO strings in UTC compare in time order. */
function byAge(a: DecisionView, b: DecisionView): number {
  if (a.since !== b.since) return a.since < b.since ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The decisions that wait on the player, oldest first, at most DECISIONS_MAX.
 * `failing` lists the agents with a doing or review task whose CI failed.
 */
export function listDecisions(input: DecisionInput): { list: DecisionView[]; failing: string[] } {
  const waiting: DecisionView[] = input.approvals.map((a): DecisionView => ({
    id: `a:${a.id}`,
    kind: "approval",
    projectId: a.projectId,
    agentId: a.agentId,
    approvalId: a.id,
    title: `${a.tool}: ${a.argsPreview}`,
    text: "",
    since: input.seen.get(a.id) ?? EPOCH,
  }));
  for (const g of input.goals) {
    waiting.push({
      id: `p:${g.id}`,
      kind: "plan",
      projectId: g.projectId,
      agentId: g.planBy ?? "boss",
      goalId: g.id,
      title: `Plan: ${g.text}`,
      text: g.plan ?? "",
      since: g.updatedAt,
    });
  }
  const failing = new Set<string>();
  for (const t of input.tasks) {
    if (t.status === "blocked") {
      if (input.activeGoals.has(t.goalId)) waiting.push(ask(t, "blocked"));
    } else if (t.status === "approval") waiting.push(ask(t, "merge"));
    else if ((t.status === "doing" || t.status === "review") && t.ci === "fail") failing.add(t.assignee ?? t.createdBy);
  }
  return { list: waiting.sort(byAge).slice(0, DECISIONS_MAX), failing: [...failing] };
}

/**
 * Keeps the first-seen time of each pending approval id. Ids missing from `ids` leave the map.
 * New ids get `now`. An id that stays keeps its time, so its place in the queue holds.
 */
export function trackSeen(seen: Map<number, string>, ids: number[], now: string): void {
  const live = new Set(ids);
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
  for (const id of ids) if (!seen.has(id)) seen.set(id, now);
}
