import os from "node:os";
import path from "node:path";

export const PROJECT_ID_RE = /^[a-z0-9-]{1,32}$/;

const RESERVED_IDS = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

/** Windows device names. A directory with one of these names cannot be created on Windows. */
export function isReservedId(id: string): boolean {
  return RESERVED_IDS.has(id);
}

export function agentCityHome(): string {
  return process.env.AGENTCITY_HOME || path.join(os.homedir(), ".agentcity");
}

export function projectDirs(home: string, id: string): { root: string; config: string; sandbox: string; outbox: string } {
  if (!PROJECT_ID_RE.test(id) || isReservedId(id)) throw new Error(`invalid project id: ${id}`);
  const root = path.join(home, "projects", id);
  return { root, config: path.join(root, "project.json"), sandbox: path.join(root, "sandbox"), outbox: path.join(root, "outbox") };
}
