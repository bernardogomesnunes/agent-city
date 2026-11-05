import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The only link the city answers. It takes no settings, so a web page cannot change what starts. */
export const LINK_URL = "agentcity://start";
const KEY = "HKCU\\Software\\Classes\\agentcity";
const COMMAND_KEY = `${KEY}\\shell\\open\\command`;

export const isLinkUrl = (u: string): boolean => /^agentcity:\/\/start\/?$/i.test(u.trim());

/** Runs reg.exe with the arguments. Returns the exit code and output. */
export type RegRunner = (args: string[]) => { code: number; out: string };

export const runReg: RegRunner = (args) => {
  const r = spawnSync("reg", args, { encoding: "utf8", windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/** What the agentcity: link runs: this node and this CLI, on the given home and port. */
export function linkCommand(o: { node: string; main: string; home: string; port: number }): string {
  for (const p of [o.node, o.main, o.home]) if (p.includes('"')) throw new Error(`path has a quote: ${p}`);
  return `"${o.node}" "${o.main}" link open --home "${o.home}" --port ${o.port} "%1"`;
}

/** Registers the agentcity: link for this Windows user. No admin rights needed. */
export function installLink(command: string, reg: RegRunner = runReg): { ok: boolean; out: string } {
  const steps = [
    ["add", KEY, "/ve", "/d", "URL:Agent City", "/f"],
    ["add", KEY, "/v", "URL Protocol", "/d", "", "/f"],
    ["add", COMMAND_KEY, "/ve", "/d", command, "/f"],
  ];
  for (const s of steps) {
    const r = reg(s);
    if (r.code !== 0) return { ok: false, out: r.out.trim() };
  }
  return { ok: true, out: "" };
}

export function removeLink(reg: RegRunner = runReg): { ok: boolean; out: string } {
  const r = reg(["delete", KEY, "/f"]);
  return { ok: r.code === 0, out: r.out.trim() };
}

/** The command the link runs now, or undefined when the link is not installed. */
export function linkStatus(reg: RegRunner = runReg): string | undefined {
  const r = reg(["query", COMMAND_KEY, "/ve"]);
  if (r.code !== 0) return undefined;
  const m = /REG_SZ\s+(.*)$/m.exec(r.out);
  return m ? m[1]!.trim() : undefined;
}

/** The quoted paths in a link command that no longer exist, so a moved repo or node shows up. */
export function missingPaths(command: string): string[] {
  const quoted = [...command.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((p) => p !== "%1");
  return quoted.filter((p) => !fs.existsSync(p));
}

/**
 * The city's websocket token, kept in the home folder so it survives a restart:
 * a page left open reconnects to a restarted city with the token it already has.
 */
export function cityToken(home: string): string {
  const file = path.join(home, "city-token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch {
    // No token yet.
  }
  const t = randomBytes(16).toString("hex");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

const lockFile = (home: string): string => path.join(home, "city.lock");

/** A running city writes its pid and port here, so other commands on this home find it on any port. */
export function writeCityLock(home: string, port: number): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(lockFile(home), JSON.stringify({ pid: process.pid, port }));
}

/** Removes the lock, unless another city on this home has replaced it. */
export function removeCityLock(home: string, port: number): void {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(home), "utf8")) as { pid?: unknown; port?: unknown };
    if (l.pid === process.pid && l.port === port) fs.rmSync(lockFile(home), { force: true });
  } catch {
    // No lock or an unreadable one: nothing to remove.
  }
}

/** The port of a city running on this home, read from its lock. A lock whose process is dead is stale and ignored. */
export function cityLockPort(home: string): number | undefined {
  let l: { pid?: unknown; port?: unknown };
  try {
    l = JSON.parse(fs.readFileSync(lockFile(home), "utf8")) as { pid?: unknown; port?: unknown };
  } catch {
    return undefined;
  }
  if (typeof l.pid !== "number" || typeof l.port !== "number") return undefined;
  try {
    process.kill(l.pid, 0);
  } catch (e) {
    // EPERM means the process exists but belongs to another user.
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  return l.port;
}

/** Whether an Agent City answers on this port. */
export async function cityAnswers(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return r.headers.get("x-agent-city") === "1";
  } catch {
    return false;
  }
}
