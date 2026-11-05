import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn as realSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCliProvider, findClaude, knownClaudeDirs, resolveClaudeBin, type ChatRequest } from "../src/index.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
const writeFileSpec = { name: "write_file", description: "Write a file", inputSchema: { type: "object" } };
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "claude-sub/haiku", messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }], tools: [], maxTokens: 100, ...over,
});

let logFile: string;
beforeEach(() => {
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ac-fake-claude-")), "log.json");
});
afterEach(() => fs.rmSync(path.dirname(logFile), { recursive: true, force: true }));

interface FakeLog { argv: string[]; cwd: string; cwdFiles: string[]; system: string | null; hasApiKey: boolean; hasAuthToken: boolean; stdin: string; pid: number }
const readLog = (): FakeLog => JSON.parse(fs.readFileSync(logFile, "utf8")) as FakeLog;

/** Runs the fake script with node in place of the claude binary. */
function provider(mode: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): ClaudeCliProvider {
  const env = { ...(opts.env ?? process.env), FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: logFile };
  return new ClaudeCliProvider({
    // An existing .exe, so a claude.cmd installed on this computer never routes the call through cmd.exe.
    claudePath: process.execPath,
    alias: "haiku",
    timeoutMs: opts.timeoutMs,
    env,
    spawn: ((_cmd: string, args: string[], o: object) => realSpawn(process.execPath, [FAKE, ...args], o)) as unknown as typeof realSpawn,
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("ClaudeCliProvider", () => {
  it("returns a parsed tool call and mapped usage", async () => {
    const r = await provider("tool").chat(req({ tools: [writeFileSpec] }));
    expect(r.toolCalls).toEqual([expect.objectContaining({ name: "write_file", args: { path: "a.txt", content: "hi" } })]);
    expect(r.text).toBe("");
    expect(r.usage).toEqual({ inputTokens: 16, outputTokens: 7 });
  });

  it("passes the required flags, the prompt on stdin, and drops API keys from env", async () => {
    await provider("text", { env: { ...process.env, ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "t" } }).chat(req({ tools: [writeFileSpec] }));
    const log = readLog();
    expect(log.argv).toEqual([
      "-p", "--output-format", "json", "--model", "haiku", "--tools", "", "--strict-mcp-config",
      "--setting-sources", "", "--no-session-persistence", "--system-prompt-file", expect.stringMatching(/system\.txt$/),
    ]);
    expect(log.system).toContain("- write_file: Write a file");
    expect(log.stdin).toBe("USER:\ngo");
    expect(log.hasApiKey).toBe(false);
    expect(log.hasAuthToken).toBe(false);
  });

  it("runs in an empty temp dir that is deleted after", async () => {
    await provider("text").chat(req());
    const log = readLog();
    expect(log.cwdFiles).toEqual([]);
    expect(fs.existsSync(log.cwd)).toBe(false);
  });

  it("returns plain text with no calls", async () => {
    expect(await provider("text").chat(req())).toMatchObject({ text: "done", toolCalls: [] });
  });

  it("handles an empty result", async () => {
    expect(await provider("empty").chat(req({ tools: [writeFileSpec] }))).toMatchObject({ text: "", toolCalls: [] });
  });

  it("maps a login error", async () => {
    await expect(provider("error").chat(req())).rejects.toThrow("Claude subscription not ready: not signed in. Open HQ, Configure, APIs and click Sign in.");
  });

  it("reports stderr on a non-zero exit", async () => {
    await expect(provider("exit").chat(req())).rejects.toThrow("boom");
  });

  it("reports a missing binary", async () => {
    await expect(new ClaudeCliProvider({ claudePath: "no-such-claude-xyz", alias: "haiku" }).chat(req())).rejects.toThrow(
      "Claude subscription not ready: claude is not installed. Open HQ, Configure, APIs and click Install.",
    );
  });

  it("kills the child on timeout", async () => {
    await expect(provider("hang", { timeoutMs: 1500 }).chat(req())).rejects.toThrow("claude did not answer in 1.5 s");
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(readLog().pid)).toBe(false);
  });

  it("kills the child on abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1000);
    await expect(provider("hang").chat(req({ signal: ac.signal }))).rejects.toThrow("aborted");
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(readLog().pid)).toBe(false);
  });
});

describe("ClaudeCliProvider input checks", () => {
  it("rejects an alias with characters cmd.exe would expand", () => {
    expect(() => new ClaudeCliProvider({ alias: 'a"b' })).toThrow("invalid claude model alias");
    expect(() => new ClaudeCliProvider({ alias: "%PATH%" })).toThrow("invalid claude model alias");
    expect(() => new ClaudeCliProvider({ alias: "claude-sonnet-4.5" })).not.toThrow();
  });

  it.skipIf(process.platform !== "win32")("runs a claude.cmd through cmd.exe with empty-string args intact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cmd-"));
    try {
      fs.writeFileSync(path.join(dir, "claude.cmd"), `@"${process.execPath}" "${FAKE}" %*\r\n`);
      const p = new ClaudeCliProvider({
        claudePath: path.join(dir, "claude"),
        alias: "haiku",
        env: { ...process.env, FAKE_CLAUDE_MODE: "text", FAKE_CLAUDE_LOG: logFile },
      });
      expect(await p.chat(req())).toMatchObject({ text: "done" });
      const log = readLog();
      expect(log.argv).toEqual([
        "-p", "--output-format", "json", "--model", "haiku", "--tools", "", "--strict-mcp-config",
        "--setting-sources", "", "--no-session-persistence", "--system-prompt-file", expect.stringMatching(/system\.txt$/),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveClaudeBin", () => {
  it.each([
    ["C:\\npm\\claude", "win32", ["C:\\npm\\claude.cmd"], "C:\\npm\\claude.cmd"],
    ["claude", "win32", ["D:\\bin\\claude.cmd"], "D:\\bin\\claude.cmd"],
    ["claude", "win32", ["D:\\bin\\claude.cmd", "D:\\bin\\claude.exe"], "D:\\bin\\claude.exe"],
    ["claude", "win32", [], "claude"],
    ["claude", "linux", [], "claude"],
    ["/usr/bin/claude", "linux", [], "/usr/bin/claude"],
  ] as const)("resolveClaudeBin(%s, %s)", (p, plat, present, want) => {
    expect(resolveClaudeBin(p, plat, (x) => (present as readonly string[]).includes(x), "D:\\bin", [])).toBe(want);
  });

  it("finds a bare claude in the installers' folders when PATH lacks it", () => {
    const win = ["C:\\Users\\b\\.local\\bin", "C:\\Users\\b\\AppData\\Roaming\\npm"];
    const has = (list: string[]) => (x: string) => list.includes(x);
    expect(findClaude("claude", "win32", has(["C:\\Users\\b\\AppData\\Roaming\\npm\\claude.cmd"]), "D:\\bin", win)).toBe("C:\\Users\\b\\AppData\\Roaming\\npm\\claude.cmd");
    expect(findClaude("claude", "win32", has(["C:\\Users\\b\\.local\\bin\\claude.exe", "D:\\bin\\claude.cmd"]), "D:\\bin", win)).toBe("D:\\bin\\claude.cmd");
    expect(findClaude("claude", "win32", has([]), "D:\\bin", win)).toBeUndefined();
    expect(findClaude("claude", "linux", has(["/home/b/.local/bin/claude"]), "/usr/bin", ["/home/b/.local/bin"])).toBe("/home/b/.local/bin/claude");
    expect(findClaude("/opt/claude", "linux", has([]), "", [])).toBeUndefined();
    expect(findClaude("/opt/claude", "linux", has(["/opt/claude"]), "", [])).toBe("/opt/claude");
  });

  it("knows where the official installer and npm put claude", () => {
    expect(knownClaudeDirs("win32", { USERPROFILE: "C:\\Users\\b", APPDATA: "C:\\Users\\b\\AppData\\Roaming" })).toEqual([
      "C:\\Users\\b\\.local\\bin", "C:\\Users\\b\\AppData\\Roaming\\npm",
    ]);
    expect(knownClaudeDirs("linux", { HOME: "/home/b" })).toEqual(["/home/b/.local/bin", "/home/b/.npm-global/bin", "/usr/local/bin"]);
  });
});
