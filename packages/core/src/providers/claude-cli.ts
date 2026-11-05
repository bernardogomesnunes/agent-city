import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTextToolCalls } from "../llm/text-tool-calls.js";
import type { ChatRequest, ChatResponse, Provider } from "../types.js";
import { renderClaudePrompt } from "./claude-prompt.js";

export const CLAUDE_NOT_FOUND =
  "Claude subscription not ready: claude is not installed. Open HQ, Configure, APIs and click Install.";
export const CLAUDE_NOT_LOGGED_IN = "Claude subscription not ready: not signed in. Open HQ, Configure, APIs and click Sign in.";

/** Env vars that would make the binary bill an API key in place of the user's own login. */
const DROPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** Where the official installer and `npm i -g` put claude, for a city started before claude was on PATH. */
export function knownClaudeDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") {
    const home = env.USERPROFILE ?? os.homedir();
    return [path.win32.join(home, ".local", "bin"), path.win32.join(env.APPDATA ?? path.win32.join(home, "AppData", "Roaming"), "npm")];
  }
  const home = env.HOME ?? os.homedir();
  return [path.posix.join(home, ".local", "bin"), path.posix.join(home, ".npm-global", "bin"), "/usr/local/bin"];
}

/**
 * The claude file to spawn, or undefined when none exists. A bare name is looked up on PATH first,
 * then in `known` folders. On Windows a name with no extension gets `.exe` before `.cmd`.
 */
export function findClaude(
  p: string,
  platform: NodeJS.Platform = process.platform,
  exists: (f: string) => boolean = fs.existsSync,
  pathEnv: string = process.env.PATH ?? "",
  known: string[] = knownClaudeDirs(platform),
): string | undefined {
  const win = platform === "win32";
  const lib = win ? path.win32 : path.posix;
  if (/[\\/]/.test(p)) {
    if (!win || lib.extname(p)) return exists(p) ? p : undefined;
    return [".exe", ".cmd"].map((e) => p + e).find(exists);
  }
  const dirs = [...pathEnv.split(win ? ";" : ":").filter(Boolean), ...known];
  const names = win && !lib.extname(p) ? [`${p}.exe`, `${p}.cmd`] : [p];
  for (const d of dirs) {
    for (const n of names) {
      const f = lib.join(d, n);
      if (exists(f)) return f;
    }
  }
  return undefined;
}

/** The file to spawn for `claudePath`: what findClaude finds, else the path as given (spawn then reports it missing). */
export function resolveClaudeBin(
  p: string,
  platform: NodeJS.Platform = process.platform,
  exists: (f: string) => boolean = fs.existsSync,
  pathEnv: string = process.env.PATH ?? "",
  known: string[] = knownClaudeDirs(platform),
): string {
  return findClaude(p, platform, exists, pathEnv, known) ?? p;
}

/** Quotes one argument for `cmd /d /s /c "..."`. Every argument here is a flag, an alias or a temp path. */
const cmdQuote = (a: string): string => `"${a.replace(/"/g, '""')}"`;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
  } else child.kill("SIGKILL");
}

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * Runs one model step through the user's own installed `claude` binary (`claude -p`), on the user's own login.
 * Built-in tools, MCP servers and settings are off; tools come back as `<tool_call>` text for the agent loop.
 */
export class ClaudeCliProvider implements Provider {
  readonly id = "claude-sub";
  readonly #claudePath: string;
  readonly #alias: string;
  readonly #timeoutMs: number;
  readonly #spawn: typeof nodeSpawn;
  readonly #env: NodeJS.ProcessEnv;

  constructor(opts: { claudePath?: string; alias: string; timeoutMs?: number; spawn?: typeof nodeSpawn; env?: NodeJS.ProcessEnv }) {
    // The alias reaches cmd.exe on Windows, where quotes and %VAR% are live inside quoted args.
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(opts.alias)) throw new Error(`invalid claude model alias: ${opts.alias}`);
    this.#claudePath = opts.claudePath ?? "claude";
    this.#alias = opts.alias;
    this.#timeoutMs = opts.timeoutMs ?? 180_000;
    this.#spawn = opts.spawn ?? nodeSpawn;
    this.#env = opts.env ?? process.env;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (req.signal?.aborted) throw new Error("aborted");
    const { system, prompt } = renderClaudePrompt(req);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentcity-claude-"));
    try {
      const cwd = path.join(root, "work");
      fs.mkdirSync(cwd);
      const systemFile = path.join(root, "system.txt");
      fs.writeFileSync(systemFile, system);
      const args = [
        "-p", "--output-format", "json", "--model", this.#alias, "--tools", "", "--strict-mcp-config",
        "--setting-sources", "", "--no-session-persistence", "--system-prompt-file", systemFile,
      ];
      const stdout = await this.#run(args, prompt, cwd, req.signal);
      return this.#toResponse(stdout, req.tools.map((t) => t.name));
    } finally {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // A temp dir left behind must not hide the call's own result or error.
      }
    }
  }

  #run(args: string[], stdin: string, cwd: string, signal?: AbortSignal): Promise<string> {
    const env = { ...this.#env };
    for (const k of DROPPED_ENV) delete env[k];
    const bin = resolveClaudeBin(this.#claudePath);
    // Node refuses to spawn a .cmd without a shell. cmd.exe gets only fixed flags and a temp path; the prompt goes on stdin.
    const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const child = viaCmd
      ? this.#spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[bin, ...args].map(cmdQuote).join(" ")}"`], {
        cwd, env, windowsHide: true, windowsVerbatimArguments: true,
      })
      : this.#spawn(bin, args, { cwd, env, windowsHide: true });

    return new Promise<string>((resolve, reject) => {
      let out = "";
      let err = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      // Kills the child and rejects once it has exited, so its working dir can be deleted. 3 s cap.
      let stopped: Error | null = null;
      const stop = (e: Error) => {
        if (stopped) return;
        stopped = e;
        killTree(child);
        setTimeout(() => finish(() => reject(e)), 3000).unref();
      };
      const timer = setTimeout(() => stop(new Error(`claude did not answer in ${this.#timeoutMs / 1000} s`)), this.#timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        stop(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort);
      child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
      child.on("error", (e: NodeJS.ErrnoException) =>
        finish(() => reject(e.code === "ENOENT" ? new Error(CLAUDE_NOT_FOUND) : e)));
      child.on("close", (code) => finish(() => {
        if (stopped) return reject(stopped);
        if (code === 0 || out.trim().startsWith("{")) return resolve(out);
        // cmd.exe reports a missing program on stderr with exit code 1.
        if (viaCmd && /not recognized/i.test(err)) return reject(new Error(CLAUDE_NOT_FOUND));
        reject(new Error(err.trim().slice(0, 300) || `claude exited with code ${code}`));
      }));
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
    });
  }

  #toResponse(stdout: string, toolNames: string[]): ChatResponse {
    let r: ClaudeResult;
    try {
      r = JSON.parse(stdout) as ClaudeResult;
    } catch {
      throw new Error(`claude returned no JSON: ${stdout.trim().slice(0, 300)}`);
    }
    const text = typeof r.result === "string" ? r.result : "";
    if (r.is_error) {
      throw new Error(/login|log in|authenticat|api key/i.test(text) ? CLAUDE_NOT_LOGGED_IN : text.slice(0, 300) || "claude reported an error");
    }
    const u = r.usage ?? {};
    const usage = {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
    };
    const { calls, rest } = parseTextToolCalls(text, toolNames);
    return { text: rest, toolCalls: calls, usage };
  }
}
