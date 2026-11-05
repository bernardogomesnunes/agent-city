// Adapted from AX Studio src/core/agents/definitions.ts (MIT).
import fs from "node:fs";
import path from "node:path";
import { AGENT_ID, AgentProfileSchema, type AgentInput, type AgentProfile } from "./profile.js";

/** Ids end up in file paths, so anything but plain characters is refused. */
function isSafeId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID.test(id);
}

export function safeId(id: string): string {
  if (!isSafeId(id)) throw new Error(`invalid id: ${JSON.stringify(id)}`);
  return id;
}

/** Write to a temp file, then rename over the target. */
export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file: string, data: unknown): void {
  writeTextAtomic(file, JSON.stringify(data, null, 2));
}

function readProfile(file: string): AgentProfile | undefined {
  try {
    return AgentProfileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Profiles at `<home>/agents/<id>/agent.json`, snapshots at `<home>/agents/<id>/versions/<n>.json`. */
export class AgentStore {
  constructor(
    private home: string,
    private now: () => Date = () => new Date(),
  ) {}

  private root(): string {
    return path.join(this.home, "agents");
  }
  private dir(id: string): string {
    return path.join(this.root(), safeId(id));
  }
  private file(id: string): string {
    return path.join(this.dir(id), "agent.json");
  }
  private versionFile(id: string, version: number): string {
    return path.join(this.dir(id), "versions", `${version}.json`);
  }

  create(input: AgentInput): AgentProfile {
    safeId(input.id);
    if (fs.existsSync(this.file(input.id))) throw new Error(`agent already exists: ${input.id}`);
    const stamp = this.now().toISOString();
    const profile = AgentProfileSchema.parse({
      ...input,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    writeJsonAtomic(this.file(profile.id), profile);
    writeJsonAtomic(this.versionFile(profile.id, 1), profile);
    fs.mkdirSync(path.join(this.dir(profile.id), "memory"), { recursive: true });
    return profile;
  }

  update(id: string, patch: Partial<Omit<AgentInput, "id">>): AgentProfile {
    const existing = this.get(id);
    if (!existing) throw new Error(`unknown agent: ${id}`);
    const merged = { ...existing };
    for (const key of ["name", "role", "persona", "model", "building", "skills"] as const) {
      if (patch[key] !== undefined) (merged as Record<string, unknown>)[key] = patch[key];
    }
    const bumps =
      merged.persona !== existing.persona || merged.model !== existing.model || merged.role !== existing.role ||
      merged.building !== existing.building || merged.skills.join(",") !== existing.skills.join(",");
    const next = AgentProfileSchema.parse({
      ...merged,
      version: bumps ? existing.version + 1 : existing.version,
      updatedAt: this.now().toISOString(),
    });
    writeJsonAtomic(this.file(id), next);
    if (bumps) writeJsonAtomic(this.versionFile(id, next.version), next);
    return next;
  }

  /** Deletes the agent's folder: profile, versions and notes. False when there is no such agent. */
  remove(id: string): boolean {
    if (!this.get(id)) return false;
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    return true;
  }

  get(id: string): AgentProfile | undefined {
    if (!isSafeId(id)) return undefined;
    return readProfile(this.file(id));
  }

  list(): AgentProfile[] {
    const dir = this.root();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(isSafeId)
      .map((id) => readProfile(this.file(id)))
      .filter((p): p is AgentProfile => p !== undefined)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  versions(id: string): AgentProfile[] {
    if (!isSafeId(id)) return [];
    const dir = path.join(this.dir(id), "versions");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readProfile(path.join(dir, f)))
      .filter((p): p is AgentProfile => p !== undefined)
      .sort((a, b) => a.version - b.version);
  }

  getVersion(id: string, version: number): AgentProfile | undefined {
    if (!isSafeId(id) || !Number.isInteger(version) || version < 1) return undefined;
    return readProfile(this.versionFile(id, version));
  }
}
