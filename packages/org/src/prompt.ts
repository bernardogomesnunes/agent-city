import type { AgentProfile } from "./profile.js";

/** Tools a lead with a team does not get: the team changes files and runs commands. */
export const LEAD_DROPS: ReadonlySet<string> = new Set(["write_file", "edit_file", "delete_file", "run_command"]);

/** How a worker handles a task. Local models otherwise add files nobody asked for. */
export const WORKER_RULES =
  "Do only the task you were given. Put new code in the files the task names; create another file only when the task asks for it.";

export function buildSystemPrompt(
  profile: AgentProfile,
  project: { id: string; allowedTools: string[] },
  extra?: { notes?: string; workspace?: { branch?: string }; skills?: Array<{ name: string; description: string }> },
): string {
  const rules = [
    `Project: ${project.id}.`,
    extra?.workspace
      ? "You work in the user's project folder. File paths and commands are relative to it."
      : "You may only write files inside the project sandbox.",
    ...(extra?.workspace?.branch
      ? [`You are on git branch ${extra.workspace.branch}. Commit your work there with run_command. Never push.`]
      : []),
    `Tools you may use: ${project.allowedTools.join(", ")}.`,
  ].join("\n");
  let out = `${profile.persona}\n\n${rules}`;
  if (profile.role === "worker") out += `\n${WORKER_RULES}`;
  const skills = extra?.skills ?? [];
  if (skills.length > 0) {
    const lines = skills.map((s) => `${s.name}: ${s.description}`).join("\n");
    out += `\n\nYour skills (load one with use_skill before doing that kind of task):\n${lines}`;
  }
  const notes = extra?.notes ?? "";
  if (notes !== "") out += `\n\nYour notes:\n${notes}`;
  return out;
}
