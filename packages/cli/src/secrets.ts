import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROVIDER_RE = /^[a-z0-9-]{1,32}$/;

export const secretsFile = (home: string): string => path.join(home, "secrets.json");

/** Provider key values by provider name. `{}` when the file is missing. */
export function readSecrets(home: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(secretsFile(home), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid secrets.json: ${(e as Error).message}`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("invalid secrets.json: expected an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(json)) if (typeof v === "string" && v.length > 0) out[k] = v;
  return out;
}

export interface RestrictDeps {
  platform?: NodeJS.Platform;
  user?: string;
  exec?: (cmd: string, args: string[]) => void;
}

/** win32: only the current user keeps access (icacls). Elsewhere: mode 600. */
export function restrictToOwner(file: string, deps: RestrictDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const user = deps.user ?? process.env.USERNAME;
    if (!user) throw new Error("cannot restrict secrets.json: USERNAME is not set");
    const exec = deps.exec ?? ((cmd, args) => void execFileSync(cmd, args, { stdio: "ignore" }));
    exec("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`]);
    return;
  }
  fs.chmodSync(file, 0o600);
}

export function setSecret(home: string, provider: string, key: string, deps: RestrictDeps = {}): void {
  if (!PROVIDER_RE.test(provider)) throw new Error(`invalid provider name: ${provider}`);
  if (!key) throw new Error("empty key");
  const all = readSecrets(home);
  all[provider] = key;
  writeSecrets(home, all, deps);
}

/** Drops one key. A missing key or file is a no-op. */
export function removeSecret(home: string, provider: string, deps: RestrictDeps = {}): void {
  const all = readSecrets(home);
  if (!(provider in all)) return;
  delete all[provider];
  writeSecrets(home, all, deps);
}

function writeSecrets(home: string, all: Record<string, string>, deps: RestrictDeps): void {
  fs.mkdirSync(home, { recursive: true });
  const file = secretsFile(home);
  // Write a temp file, restrict it, then rename over the target. A failed restrict never leaves a readable key.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  try {
    restrictToOwner(tmp, deps);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`could not restrict secrets.json to the current user: ${e instanceof Error ? e.message : String(e)}`);
  }
  fs.renameSync(tmp, file);
}
