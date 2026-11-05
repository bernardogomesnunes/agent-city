import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { HqConfig } from "@agentcity/world/shared";
import { loadGlobalConfig, loadProjectConfig, redact } from "@agentcity/safety";
import { AgentStore, SkillStore } from "@agentcity/org";
import { readSecrets } from "./secrets.js";
import { runCli, type CliDeps } from "./wire.js";
import { mcpAuthFile } from "./mcp-auth.js";
import { agentBranches, baseBranch, isGitRepo } from "./workspace.js";
import { claudeStatus, describeClaude } from "./claude-setup.js";

/**
 * Commands HQ forms may run, as "<command> <subcommand>". Anything else is refused.
 * `run` and `city` stay out: runs start through the run message, and the city cannot start itself.
 */
export const HQ_COMMANDS = new Set([
  "init", "grant", "revoke", "kill", "unkill",
  "agent create", "agent edit", "agent remove",
  "connection add", "connection remove",
  "lmstudio url",
  "secrets set",
  "mcp add", "mcp remove", "mcp allow", "mcp ask", "mcp grant", "mcp revoke", "mcp tools",
  "project link", "project unlink", "project edits", "project limits", "project safe", "project protect", "project merge", "project branches", "project remove",
  "skill add", "skill remove",
  "claude status", "claude install", "claude signin",
]);

export function hqAllowed(argv: string[]): boolean {
  const [a, b] = argv;
  if (a === undefined) return false;
  return HQ_COMMANDS.has(a) || (b !== undefined && HQ_COMMANDS.has(`${a} ${b}`));
}

/** Runs one HQ command in process. `input` answers a hidden prompt (secrets set) and never reaches the output. */
export async function runHqCommand(
  home: string,
  argv: string[],
  input: string | undefined,
  deps: Pick<CliDeps, "providerOverride"> = {},
): Promise<{ code: number; text: string }> {
  if (!hqAllowed(argv)) return { code: 1, text: `HQ cannot run: ${argv.slice(0, 2).join(" ")}` };
  const inp = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (d: Buffer) => (text += d.toString()));
  if (input !== undefined) inp.end(input + "\n");
  else inp.end();
  const code = await runCli(argv, { ...deps, home, io: { input: inp, output, error: output }, exit: () => undefined });
  // Every stored secret, plus the one just typed, is masked in what goes back to the page.
  const secrets = [...Object.values(readSecrets(home)), ...(input ? [input] : [])];
  return { code, text: redact(text, secrets).trim() };
}

function projectIds(home: string): string[] {
  const dir = path.join(home, "projects");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((id) => fs.existsSync(path.join(dir, id, "project.json"))).sort();
}

/** What the HQ settings tabs show. Secret values never leave the server, only their names. */
export function hqConfig(home: string): HqConfig {
  const global = loadGlobalConfig(home);
  const secrets = readSecrets(home);
  const claude = claudeStatus(global.claudePath);
  const projects: HqConfig["projects"] = [];
  for (const id of projectIds(home)) {
    const c = loadProjectConfig(home, id);
    if (!c.ok) continue;
    const mcp = c.config.allowedTools.filter((t) => /^mcp__[a-z0-9-]+__\*$/.test(t)).map((t) => t.slice(5, -3));
    const ws = c.config.workspace;
    let git: { base?: string; branches: HqConfig["projects"][number]["branches"] } = { branches: [] };
    try {
      if (ws && isGitRepo(ws)) {
        const base = baseBranch(ws);
        git = { base, branches: agentBranches(ws, base) };
      }
    } catch {
      // a broken repo shows no branches
    }
    projects.push({ id, agents: c.config.agents, edits: c.config.edits, budget: c.config.budget, limits: c.config.limits, mcp, ...git, ...(ws ? { workspace: ws } : {}) });
  }
  return {
    projects,
    agents: new AgentStore(home).list().map((p) => ({
      id: p.id, name: p.name, role: p.role, model: p.model, persona: p.persona, building: p.building, skills: p.skills, version: p.version,
    })),
    connections: global.connections.map((c) => ({ name: c.name, baseUrl: c.baseUrl, hasKey: secrets[`api-${c.name}`] !== undefined })),
    lmStudio: { baseUrl: global.lmStudioBaseUrl, hasKey: secrets.lmstudio !== undefined },
    mcpServers: global.mcpServers.map((s) => ({
      name: s.name,
      where: s.command !== undefined ? [s.command, ...s.args].join(" ") : s.url!,
      allow: s.allow,
      oauth: s.url !== undefined,
      signedIn: fs.existsSync(mcpAuthFile(home, s.name)),
    })),
    skills: new SkillStore(home).list(),
    secrets: Object.keys(secrets).sort(),
    claude: { ...claude, text: describeClaude(claude) },
  };
}
