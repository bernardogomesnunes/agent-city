import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ID_RE, isReservedId, projectDirs } from "./home.js";
import { DEFAULT_PRICES, type Price, type Prices } from "./pricing.js";

const nonNeg = z.number().finite().nonnegative();

export const DEFAULT_PROTECTED = [".env*", ".git/**", ".github/**"] as const;
export const DEFAULT_SAFE_COMMANDS = [
  "npm test", "npm run test", "npm run build", "npm run lint", "npm run typecheck",
  "git status", "git diff", "git log", "git show", "git add", "git commit",
] as const;

/**
 * Limits the player sets per project. stepsPerJob and parallelJobs: 0 means no limit.
 * The four retry counts are tries: 0 means none.
 */
export const LIMIT_DEFAULTS = { stepsPerJob: 0, parallelJobs: 1, reminders: 1, testFixes: 1, sendBacks: 2, conflicts: 1 } as const;
export const LimitsSchema = z.object({
  stepsPerJob: z.number().int().nonnegative().default(LIMIT_DEFAULTS.stepsPerJob),
  parallelJobs: z.number().int().nonnegative().default(LIMIT_DEFAULTS.parallelJobs),
  reminders: z.number().int().nonnegative().default(LIMIT_DEFAULTS.reminders),
  testFixes: z.number().int().nonnegative().default(LIMIT_DEFAULTS.testFixes),
  sendBacks: z.number().int().nonnegative().default(LIMIT_DEFAULTS.sendBacks),
  conflicts: z.number().int().nonnegative().default(LIMIT_DEFAULTS.conflicts),
});
export type Limits = z.infer<typeof LimitsSchema>;
export const LIMIT_NAMES = Object.keys(LIMIT_DEFAULTS) as Array<keyof Limits>;

export const ProjectConfigSchema = z.object({
  id: z.string().regex(PROJECT_ID_RE).refine((v) => !isReservedId(v), "reserved id"),
  agents: z.array(z.string()),
  allowedTools: z.array(z.string()),
  allowedModels: z.array(z.string()),
  /** jobTokens: tokens one job may use. dayUsd: dollars the project may spend per local day. 0 means no cap. */
  budget: z.object({ jobTokens: nonNeg.default(200000), dayUsd: nonNeg.default(1) }).default({ jobTokens: 200000, dayUsd: 1 }),
  limits: LimitsSchema.default({ ...LIMIT_DEFAULTS }),
  autoApprove: z.object({ enabled: z.boolean(), maxUsdPerAction: nonNeg, maxUsdPerDay: nonNeg }),
  killSwitch: z.boolean(),
  delegation: z
    .object({
      maxDepth: z.number().int().nonnegative(),
      maxTreeUsd: nonNeg,
      maxChildRuns: z.number().int().nonnegative(),
    })
    .default({ maxDepth: 3, maxTreeUsd: 0.5, maxChildRuns: 10 }),
  /** Absolute path of a linked folder. Tools work there in place of the sandbox. */
  workspace: z.string().optional(),
  /** auto: file writes and edits run at once. ask: each one asks the user. */
  edits: z.enum(["auto", "ask"]).default("auto"),
  /** Globs of files whose edits always ask, relative to the folder. */
  protectedPaths: z.array(z.string()).default([...DEFAULT_PROTECTED]),
  /** Commands that run without asking. A command matches when it equals an entry or starts with the entry and a space. */
  safeCommands: z.array(z.string()).default([...DEFAULT_SAFE_COMMANDS]),
  /** Goal board settings: the command that tests a task. `maxConcurrent` is read only from older configs, as limits.parallelJobs. */
  board: z.object({
    maxConcurrent: z.number().int().min(1).max(8).optional(),
    testCommand: z.string().optional(),
  }).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function defaultProjectConfig(id: string): ProjectConfig {
  return {
    id,
    agents: [],
    allowedTools: [],
    allowedModels: ["claude-haiku-5-5", "lmstudio/*", "claude-sub/*", "api/*"],
    budget: { jobTokens: 200000, dayUsd: 1 },
    limits: { ...LIMIT_DEFAULTS },
    autoApprove: { enabled: false, maxUsdPerAction: 0, maxUsdPerDay: 0 },
    killSwitch: false,
    delegation: { maxDepth: 3, maxTreeUsd: 0.5, maxChildRuns: 10 },
    edits: "auto",
    protectedPaths: [...DEFAULT_PROTECTED],
    safeCommands: [...DEFAULT_SAFE_COMMANDS],
  };
}

/** A config with no `limits` keeps its parallel cap in board.maxConcurrent. That value becomes limits.parallelJobs. */
function withLegacyParallelJobs(json: unknown): unknown {
  if (typeof json !== "object" || json === null || "limits" in json) return json;
  const board = (json as { board?: { maxConcurrent?: unknown } }).board;
  if (board?.maxConcurrent === undefined) return json;
  return { ...json, limits: { parallelJobs: board.maxConcurrent } };
}

/** Tools that no longer exist. A loaded config drops them. */
const REMOVED_TOOLS: ReadonlySet<string> = new Set(["delegate", "report"]);

export function loadProjectConfig(home: string, id: string): { ok: true; config: ProjectConfig } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(projectDirs(home, id).config, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read project config: ${(e as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const parsed = ProjectConfigSchema.safeParse(withLegacyParallelJobs(json));
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  // delegate was removed with the goal board. Older configs still list it.
  const allowedTools = parsed.data.allowedTools.filter((t) => !REMOVED_TOOLS.has(t));
  return { ok: true, config: { ...parsed.data, allowedTools } };
}

export function saveProjectConfig(home: string, config: ProjectConfig): void {
  const valid = ProjectConfigSchema.parse(config);
  const d = projectDirs(home, valid.id);
  fs.mkdirSync(path.dirname(d.config), { recursive: true });
  fs.mkdirSync(d.sandbox, { recursive: true });
  fs.mkdirSync(d.outbox, { recursive: true });
  fs.writeFileSync(d.config, JSON.stringify(valid, null, 2) + "\n");
}

/** An OpenAI-compatible endpoint. Its key is the secret `api-<name>`. `price` applies to every model on it. */
export interface Connection { name: string; baseUrl: string; price?: Price }

export interface GlobalConfig { prices: Prices; lmStudioBaseUrl: string; connections: Connection[]; claudePath: string; mcpServers: McpServer[] }

export const CONNECTION_NAME_RE = /^[a-z0-9-]{1,24}$/;

const priceSchema = z.object({ inputPerMTok: nonNeg, outputPerMTok: nonNeg });

export const ConnectionSchema = z.object({
  name: z.string().regex(CONNECTION_NAME_RE),
  baseUrl: z.string().refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "baseUrl must be an http or https URL"),
  price: priceSchema.optional(),
});

export const MCP_NAME_RE = /^[a-z0-9-]{1,24}$/;

/**
 * An MCP server agents can use. stdio servers set `command`, HTTP servers set `url`.
 * Values in `env` and `headers` may hold `secret:<name>`, replaced at start by that stored secret.
 * Tools in `allow` run without asking. Every other tool asks.
 */
export const McpServerSchema = z
  .object({
    name: z.string().regex(MCP_NAME_RE),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    allow: z.array(z.string()).default([]),
  })
  .refine((v) => (v.command === undefined) !== (v.url === undefined), "set command or url, not both");
export type McpServer = z.infer<typeof McpServerSchema>;

function readConfigJson(home: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, "config.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`invalid config.json: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid config.json: ${(e as Error).message}`);
  }
}

/** Replaces the MCP server list in config.json. Every other key in the file stays. */
export function saveMcpServers(home: string, servers: McpServer[]): void {
  const valid = z.array(McpServerSchema).parse(servers);
  const json = readConfigJson(home) ?? {};
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("invalid config.json: not an object");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ ...json, mcpServers: valid }, null, 2) + "\n");
}

/**
 * The base URL an OpenAI-compatible server is called at. A bare host gets `/v1`; trailing slashes go.
 * A path stays as written, so `https://api.groq.com/openai/v1` is unchanged.
 */
export function apiBaseUrl(url: string): string {
  const raw = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  // Trailing slashes go from the path only. A bare host has the path "/", which becomes "/v1" before the query.
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path === "" ? "/v1" : path;
  return parsed.toString();
}

/** Saves the LM Studio base URL in config.json, through apiBaseUrl. Every other key in the file stays. */
export function saveLmStudioBaseUrl(home: string, url: string): void {
  const base = apiBaseUrl(url);
  if (!ConnectionSchema.shape.baseUrl.safeParse(base).success) throw new Error("LM Studio URL must be an http or https URL");
  const json = readConfigJson(home) ?? {};
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("invalid config.json: not an object");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ ...json, lmStudioBaseUrl: base }, null, 2) + "\n");
}

/** Replaces the connections list in config.json. Every other key in the file stays. */
export function saveConnections(home: string, connections: Connection[]): void {
  const valid = z.array(ConnectionSchema).parse(connections);
  const json = readConfigJson(home) ?? {};
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("invalid config.json: not an object");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ ...json, connections: valid }, null, 2) + "\n");
}

export function loadGlobalConfig(home: string): GlobalConfig {
  const defaults: GlobalConfig = {
    prices: { ...DEFAULT_PRICES }, lmStudioBaseUrl: "http://localhost:1234/v1", connections: [], claudePath: "claude", mcpServers: [],
  };
  const json = readConfigJson(home);
  if (json === undefined) return defaults;
  const parsed = z
    .object({
      prices: z.record(z.string(), priceSchema).optional(),
      lmStudioBaseUrl: z.string().optional(),
      connections: z.array(ConnectionSchema).optional(),
      claudePath: z.string().min(1).optional(),
      mcpServers: z.array(McpServerSchema).optional(),
    })
    .safeParse(json);
  if (!parsed.success) throw new Error(`invalid config.json: ${parsed.error.message}`);
  const connections = parsed.data.connections ?? [];
  const seen = new Set<string>();
  for (const c of connections) {
    if (seen.has(c.name)) throw new Error(`invalid config.json: duplicate connection ${c.name}`);
    seen.add(c.name);
  }
  return {
    prices: { ...defaults.prices, ...parsed.data.prices },
    lmStudioBaseUrl: apiBaseUrl(parsed.data.lmStudioBaseUrl ?? defaults.lmStudioBaseUrl),
    connections: connections.map((c) => ({ ...c, baseUrl: apiBaseUrl(c.baseUrl) })),
    claudePath: parsed.data.claudePath ?? defaults.claudePath,
    mcpServers: parsed.data.mcpServers ?? [],
  };
}
