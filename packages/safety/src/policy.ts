import { globToRegExp, relPath } from "@agentcity/core";
import type { ProjectConfig } from "./config.js";

type Policy = Pick<ProjectConfig, "edits" | "protectedPaths" | "safeCommands">;

/** Characters that chain, redirect or expand in cmd.exe or sh. A command holding one never counts as safe. */
const SHELL_META = /[;&|<>`$()\r\n^%!]/;
const GIT_PUSH = /^\s*git\s+push\b/i;
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

/** True when the path is on the protected list or leaves the folder. */
export function isProtected(policy: Pick<Policy, "protectedPaths">, p: string): boolean {
  const rel = relPath(p);
  if (rel === null) return true;
  return policy.protectedPaths.some((g) => {
    const re = globToRegExp(g);
    // a folder pattern like ".git/**" also covers the folder itself
    return re.test(rel) || re.test(rel + "/");
  });
}

/** True when the command runs without asking: no shell operators, not git push, and on the safe list. */
export function isSafeCommand(policy: Pick<Policy, "safeCommands">, command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  if (SHELL_META.test(c) || GIT_PUSH.test(c)) return false;
  return policy.safeCommands.some((s) => {
    const safe = s.trim().replace(/\s+/g, " ");
    return safe !== "" && (c === safe || c.startsWith(safe + " "));
  });
}

/**
 * The tier the gate uses for one call. Edits drop to 2 (ask) when the project or run asks for edits,
 * or the path is protected. run_command rises to 1 (no ask) only for a safe command.
 */
export function effectiveTier(policy: Policy, name: string, args: unknown, baseTier: 0 | 1 | 2 | 3, askEdits = false): 0 | 1 | 2 | 3 {
  const a = (args ?? {}) as { path?: unknown; command?: unknown };
  if (EDIT_TOOLS.has(name)) {
    const p = typeof a.path === "string" ? a.path : "";
    return askEdits || policy.edits === "ask" || isProtected(policy, p) ? Math.max(baseTier, 2) as 2 | 3 : baseTier;
  }
  if (name === "run_command") return typeof a.command === "string" && isSafeCommand(policy, a.command) ? 1 : baseTier;
  return baseTier;
}
