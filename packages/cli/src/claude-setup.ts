import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findClaude, knownClaudeDirs } from "@agentcity/core";

/** Whether the Claude subscription can run: claude found, and a saved sign-in. `signedIn` is null where it cannot be told (macOS keeps it in the keychain). */
export interface ClaudeStatus {
  path: string | null;
  signedIn: boolean | null;
}

export const CLAUDE_INSTALL = "npm i -g @anthropic-ai/claude-code";

/** Finds claude and its saved sign-in file. Costs no tokens: nothing runs. */
export function claudeStatus(
  claudePath: string,
  o: { platform?: NodeJS.Platform; exists?: (f: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): ClaudeStatus {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? fs.existsSync;
  const env = o.env ?? process.env;
  const found = findClaude(claudePath, platform, exists, env.PATH ?? "", knownClaudeDirs(platform, env)) ?? null;
  if (platform === "darwin") return { path: found, signedIn: found ? null : false };
  const lib = platform === "win32" ? path.win32 : path.posix;
  const dir = env.CLAUDE_CONFIG_DIR ?? lib.join((platform === "win32" ? env.USERPROFILE : env.HOME) ?? os.homedir(), ".claude");
  return { path: found, signedIn: exists(lib.join(dir, ".credentials.json")) };
}

/**
 * The console line that signs in: `claude auth login` opens the browser and exits.
 * Plain `claude` starts the full-screen app, which draws badly in a cmd window. Undefined for a path cmd.exe would expand.
 */
export function signinCommand(claudePath: string): string | undefined {
  return /["%]/.test(claudePath) ? undefined : `"${claudePath}" auth login --claudeai`;
}

/** One line for HQ and the terminal. */
export function describeClaude(s: ClaudeStatus): string {
  if (!s.path) return "not installed";
  if (s.signedIn === false) return "not signed in";
  return s.signedIn === null ? `installed at ${s.path}; sign in once if runs fail` : `ready (${s.path})`;
}

/**
 * Opens a console window on this computer that runs `command` and stays open, so the player sees it work.
 * Windows only: other systems get an error with the command to run themselves.
 */
export function openConsole(
  title: string,
  command: string,
  o: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn } = {},
): { ok: true } | { ok: false; error: string } {
  if ((o.platform ?? process.platform) !== "win32") return { ok: false, error: `Open a terminal and run: ${command}` };
  const spawn = o.spawn ?? nodeSpawn;
  // start opens a new window; cmd /k keeps it open after the command. Title and command are fixed strings or a found path.
  const child = spawn("cmd.exe", ["/d", "/c", "start", `"${title}"`, "cmd.exe", "/k", command], {
    detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: true,
  });
  child.on("error", () => undefined);
  child.unref();
  return { ok: true };
}
