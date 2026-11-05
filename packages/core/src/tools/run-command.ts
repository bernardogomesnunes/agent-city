import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import type { Tool } from "./types.js";

export const OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
/** Environment names that look like credentials. Commands never see them. */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // the group already exited
    }
  }
}

export const runCommandTool: Tool<{ command: string; timeoutSec?: number }> = {
  name: "run_command",
  description:
    `Run one shell command in the project folder. Returns the exit code and the last ${OUTPUT_CHARS} characters of output. ` +
    "Commands on the project's safe list run at once. Others ask the user, and so does any command joined with && ; | or using redirects, " +
    "so run one command per call. git push always asks. " +
    (process.platform === "win32"
      ? 'The shell is cmd.exe: quote arguments with double quotes, e.g. git commit -m "fix add". Single quotes do not quote.'
      : "The shell is sh."),
  tier: 2,
  schema: z.object({
    command: z.string().min(1),
    timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_S).optional().describe(`Default ${DEFAULT_TIMEOUT_S}`),
  }),
  run(args, ctx) {
    return new Promise((resolve, reject) => {
      const child = spawn(args.command, {
        cwd: ctx.sandboxDir,
        shell: true,
        env: commandEnv(),
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let cut = false;
      const add = (d: Buffer) => {
        out += d.toString("utf8");
        if (out.length > OUTPUT_CHARS * 2) {
          out = out.slice(-OUTPUT_CHARS);
          cut = true;
        }
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      let stopped: string | undefined;
      const stop = (why: string) => {
        stopped ??= why;
        if (child.pid !== undefined) killTree(child.pid);
      };
      const timer = setTimeout(() => stop(`timed out after ${args.timeoutSec ?? DEFAULT_TIMEOUT_S} s`), (args.timeoutSec ?? DEFAULT_TIMEOUT_S) * 1000);
      const onAbort = () => stop("aborted");
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const body = cut || out.length > OUTPUT_CHARS ? `[output cut to the last ${OUTPUT_CHARS} characters]\n` + out.slice(-OUTPUT_CHARS) : out;
        const head = stopped ? `stopped: ${stopped}` : `exit code ${code ?? "none"}`;
        resolve(`${head}\n${body}`.trimEnd());
      });
    });
  },
};
