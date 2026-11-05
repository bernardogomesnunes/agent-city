import { describe, expect, it, vi } from "vitest";
import { CLAUDE_INSTALL, claudeStatus, describeClaude, openConsole, signinCommand } from "../src/claude-setup.js";

const env = { USERPROFILE: "C:\\Users\\b", APPDATA: "C:\\Users\\b\\AppData\\Roaming", PATH: "C:\\Windows" };
const has = (list: string[]) => (f: string) => list.includes(f);

describe("claude setup", () => {
  it("reports not installed, not signed in, and ready from files alone", () => {
    expect(claudeStatus("claude", { platform: "win32", env, exists: has([]) })).toEqual({ path: null, signedIn: false });
    const exe = "C:\\Users\\b\\.local\\bin\\claude.exe";
    expect(claudeStatus("claude", { platform: "win32", env, exists: has([exe]) })).toEqual({ path: exe, signedIn: false });
    expect(claudeStatus("claude", { platform: "win32", env, exists: has([exe, "C:\\Users\\b\\.claude\\.credentials.json"]) })).toEqual({ path: exe, signedIn: true });
    expect(claudeStatus("claude", { platform: "win32", env: { ...env, CLAUDE_CONFIG_DIR: "D:\\cc" }, exists: has([exe, "D:\\cc\\.credentials.json"]) }).signedIn).toBe(true);
    expect(claudeStatus("claude", { platform: "darwin", env: { HOME: "/Users/b", PATH: "/usr/bin" }, exists: has(["/usr/bin/claude"]) })).toEqual({ path: "/usr/bin/claude", signedIn: null });
  });

  it("signs in through claude auth login, which opens the browser and skips the full-screen app", () => {
    expect(signinCommand("C:/npm/claude.cmd")).toBe('"C:/npm/claude.cmd" auth login --claudeai');
    expect(signinCommand('C:/x"y/claude.cmd')).toBeUndefined();
    expect(signinCommand("C:/%PATH%/claude.cmd")).toBeUndefined();
  });

  it("describes each state in one line", () => {
    expect(describeClaude({ path: null, signedIn: false })).toBe("not installed");
    expect(describeClaude({ path: "c", signedIn: false })).toBe("not signed in");
    expect(describeClaude({ path: "c", signedIn: true })).toBe("ready (c)");
  });

  it("opens a console window that stays open on Windows, and gives the command elsewhere", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    expect(openConsole("Install Claude Code", CLAUDE_INSTALL, { platform: "win32", spawn: spawn as never })).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/d", "/c", "start", '"Install Claude Code"', "cmd.exe", "/k", CLAUDE_INSTALL], expect.objectContaining({ detached: true }));
    expect(child.unref).toHaveBeenCalled();
    expect(openConsole("x", "claude", { platform: "linux", spawn: spawn as never })).toEqual({ ok: false, error: "Open a terminal and run: claude" });
  });
});
