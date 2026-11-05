import type { GoalView, TaskView } from "@agentcity/world/shared";
import type { AgentConfigView } from "./projects-panel.js";

/**
 * The agent a goal Chat opens: the createdBy of the goal's first task whose author has role manager, else the first
 * manager among the project's agents, else the first project agent. A project with no agents falls back to the
 * first manager of the city, else "".
 */
export function managerOf(goal: GoalView, tasks: TaskView[], agents: AgentConfigView[], city: AgentConfigView[] = agents): string {
  const roleOf = (id: string) => [...agents, ...city].find((a) => a.id === id)?.role;
  const maker = tasks.find((t) => t.goalId === goal.id && roleOf(t.createdBy) === "manager")?.createdBy;
  if (maker) return maker;
  if (agents.length > 0) return (agents.find((a) => a.role === "manager") ?? agents[0]!).id;
  return city.find((a) => a.role === "manager")?.id ?? "";
}

/** The agents a task Chat can pick from: the project's agents, and every agent the city knows. */
export interface ChatAgents {
  project: AgentConfigView[];
  city: AgentConfigView[];
}

/** The agent a task Chat opens: the assignee when the city knows it, else the Manager of the task's goal. */
export function taskChatAgent(t: TaskView, board: { goals: GoalView[]; tasks: TaskView[] }, agents: ChatAgents): string {
  if (t.assignee !== null && agents.city.some((a) => a.id === t.assignee)) return t.assignee;
  const goal = board.goals.find((g) => g.id === t.goalId);
  return managerOf(goal ?? { id: t.goalId } as GoalView, board.tasks, agents.project, agents.city);
}
