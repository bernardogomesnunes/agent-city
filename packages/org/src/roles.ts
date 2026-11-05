import type { AgentRole } from "./profile.js";

const RANK: Record<AgentRole, number> = { boss: 2, manager: 1, worker: 0 };

/** A role may delegate to a strictly lower role: boss to manager or worker, manager to worker. */
export function canDelegate(from: AgentRole, to: AgentRole): boolean {
  return RANK[from] > RANK[to];
}
