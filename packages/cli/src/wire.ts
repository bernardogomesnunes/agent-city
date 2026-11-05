import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { Command, CommanderError, Option } from "commander";
import { ProviderUnreachableError, builtInTools, type Provider, type RunResult } from "@agentcity/core";
import {
  ActionLog,
  type ActionRow,
  BoardStore,
  agentCityHome,
  redact,
  ConnectionSchema,
  McpServerSchema,
  saveMcpServers,
  type McpServer,
  defaultProjectConfig,
  loadGlobalConfig,
  saveConnections,
  saveLmStudioBaseUrl,
  apiBaseUrl,
  loadProjectConfig,
  openDb,
  projectDirs,
  saveProjectConfig,
  LIMIT_NAMES,
  type ProjectConfig,
} from "@agentcity/safety";
import { AgentStore, MemoryStore, SkillStore, parseModelId, type AgentRole, type AgentBuilding } from "@agentcity/org";
import { LineReader, type ClosableApprover } from "./approver.js";
import { TreeRunner } from "./tree-runner.js";
import { formatEvent, providerFor, NO_ANTHROPIC_KEY, type CliIo } from "./shared.js";
import { readSecrets, removeSecret, setSecret } from "./secrets.js";
import { startCityServer } from "./city-server.js";
import { agentBranches, isGitRepo, mergeAgentBranch, resolveFolder } from "./workspace.js";
import { removedText, removeProjectFiles } from "./worktrees.js";
import { McpHub, literalSecrets, mcpGrant } from "./mcp.js";
import { CLAUDE_INSTALL, claudeStatus, describeClaude, openConsole, signinCommand } from "./claude-setup.js";
import { LINK_URL, cityAnswers, cityLockPort, cityToken, installLink, isLinkUrl, linkCommand, linkStatus, missingPaths, removeLink, runReg, type RegRunner } from "./link.js";

export { formatEvent, providerFor, NO_ANTHROPIC_KEY };
export type { CliIo };

export interface CliDeps {
  home?: string;
  io?: Partial<CliIo>;
  providerOverride?: Provider;
  /** Registers the interrupt handler. Default: process SIGINT. Returns an unregister function. */
  registerInterrupt?: (handler: () => void | Promise<void>) => () => void;
  /** Called by the interrupt handler after cleanup. Default: process.exit. */
  exit?: (code: number) => void;
  /** Replaces the terminal approver for `run`. Used by the city server. */
  approverFactory?: (agentName: string) => ClosableApprover;
  /** Overrides the client build folder for `city`. Used by tests. */
  staticDir?: string;
  /** Replaces reg.exe for `link`. Used by tests. */
  reg?: RegRunner;
  /** Overrides process.platform for `link`. Used by tests. */
  platform?: NodeJS.Platform;
  /** Replaces the console window `claude install` and `claude signin` open. Used by tests. */
  openConsole?: typeof openConsole;
}

async function readHidden(io: CliIo, prompt: string): Promise<string> {
  io.output.write(prompt);
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = readline.createInterface({
    input: io.input,
    output: muted,
    terminal: Boolean((io.input as NodeJS.ReadStream).isTTY),
  });
  const line = await new Promise<string>((resolve) => {
    rl.once("line", resolve);
    rl.once("close", () => resolve(""));
  });
  rl.close();
  io.output.write("\n");
  return line.trim();
}

const defaultRegister = (h: () => void | Promise<void>): (() => void) => {
  const fn = () => void h();
  process.on("SIGINT", fn);
  return () => void process.off("SIGINT", fn);
};

export function buildProgram(deps: CliDeps = {}): Command {
  const io: CliIo = {
    input: deps.io?.input ?? process.stdin,
    output: deps.io?.output ?? process.stdout,
    error: deps.io?.error ?? process.stderr,
  };
  const home = deps.home ?? agentCityHome();
  const register = deps.registerInterrupt ?? defaultRegister;
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const out = (s: string) => void io.output.write(s + "\n");
  const fail = (msg: string, code = 1): never => {
    io.error.write(msg + "\n");
    throw new CommanderError(code, "agentcity.fail", msg);
  };
  const guard =
    <A extends unknown[]>(fn: (...a: A) => Promise<void> | void) =>
    async (...a: A): Promise<void> => {
      try {
        await fn(...a);
      } catch (e) {
        if (e instanceof CommanderError) throw e;
        fail(e instanceof Error ? e.message : String(e));
      }
    };
  const loadConfig = (project: string): ProjectConfig => {
    const r = loadProjectConfig(home, project);
    if (!r.ok) return fail(`Project ${project} is missing or invalid (${r.error}). Run: agentcity init ${project}`);
    return r.config;
  };
  const personaFrom = (o: { persona?: string; personaFile?: string }): string | undefined => {
    if (o.persona !== undefined && o.personaFile !== undefined) return fail("Use --persona or --persona-file, not both.");
    if (o.personaFile !== undefined) return fs.readFileSync(o.personaFile, "utf8");
    return o.persona;
  };
  /** Fails on a model id that no source can run. */
  const checkModel = (model: string | undefined): void => {
    if (model === undefined) return;
    const r = parseModelId(model, loadGlobalConfig(home).connections.map((c) => c.name));
    if (!r.ok) fail(r.error);
  };

  const program = new Command("agentcity");
  program
    .exitOverride()
    .configureOutput({ writeOut: (s) => void io.output.write(s), writeErr: (s) => void io.error.write(s) });

  program
    .command("init <project>")
    .description("Create a project folder and default config")
    .option("--path <folder>", "work in this existing folder in place of the sandbox")
    .action(
      guard((project: string, o: { path?: string }) => {
        const d = projectDirs(home, project);
        if (fs.existsSync(d.config)) return fail(`Project ${project} already exists.`);
        const config: ProjectConfig = { ...defaultProjectConfig(project), allowedTools: [...builtInTools.map((t) => t.name), "remember"] };
        saveProjectConfig(home, o.path ? linkFolder(config, o.path) : config);
        out(`Created project ${project} at ${d.root}`);
        if (o.path) out(linkedLine(loadConfig(project)));
      }),
    );

  /** Sets the folder, picks the edit mode from git, and adds any missing built-in tools. */
  const linkFolder = (config: ProjectConfig, folder: string): ProjectConfig => {
    const workspace = resolveFolder(folder);
    const tools = [...config.allowedTools];
    for (const t of builtInTools) if (!tools.includes(t.name)) tools.push(t.name);
    return { ...config, workspace, edits: isGitRepo(workspace) ? "auto" : "ask", allowedTools: tools };
  };
  const linkedLine = (c: ProjectConfig): string =>
    `Linked ${c.workspace}. Edits: ${c.edits}${c.edits === "auto" ? " (git repo, each run gets its own branch)" : " (not a git repo, every edit asks)"}.`;

  const proj = program.command("project").description("Project folder and edit rules");
  proj
    .command("link <project> <folder>")
    .description("Work in an existing folder in place of the sandbox")
    .action(
      guard((project: string, folder: string) => {
        saveProjectConfig(home, linkFolder(loadConfig(project), folder));
        out(linkedLine(loadConfig(project)));
      }),
    );
  proj
    .command("unlink <project>")
    .description("Go back to the project sandbox")
    .action(
      guard((project: string) => {
        const c = loadConfig(project);
        delete c.workspace;
        saveProjectConfig(home, c);
        out(`${project} uses its sandbox again.`);
      }),
    );
  proj
    .command("remove <project>")
    .description("Delete the project's board, config, sandbox and its task branches. A linked folder and its files stay")
    .option("--port <n>", "port the city uses", "4321")
    .action(
      guard(async (project: string, o: { port: string }) => {
        if (!fs.existsSync(projectDirs(home, project).config)) return fail(`No project ${project}`);
        if (cityLockPort(home) !== undefined) {
          return fail(`the city is running; delete the project from the city; if no city runs, delete ${path.join(home, "city.lock")}`);
        }
        if (await cityAnswers(Number(o.port))) return fail("the city is running; delete the project from the city");
        const db = openDb(home);
        try {
          const board = new BoardStore(db);
          // Files first, rows last: a file error leaves the project listed.
          const removed = removeProjectFiles(home, project, board.branches(project));
          board.deleteProject(project);
          out(removedText(project, removed));
        } finally {
          db.close();
        }
      }),
    );
  proj
    .command("show <project>")
    .action(
      guard((project: string) => {
        const c = loadConfig(project);
        out(`folder: ${c.workspace ?? `${projectDirs(home, project).sandbox} (sandbox)`}`);
        out(`edits: ${c.edits}`);
        out(`protected: ${c.protectedPaths.join(", ") || "(none)"}`);
        out(`safe commands: ${c.safeCommands.join(", ") || "(none)"}`);
      }),
    );
  proj
    .command("branches <project>")
    .description("Agent branches waiting to merge")
    .action(
      guard((project: string) => {
        const ws = loadConfig(project).workspace;
        if (!ws || !isGitRepo(ws)) return fail(`${project} is not linked to a git folder.`);
        const list = agentBranches(ws);
        if (list.length === 0) out("Nothing waiting to merge.");
        for (const b of list) out(`${b.name}\t${b.ahead} commit(s)\t${b.stat}\t${b.subject}`);
      }),
    );
  proj
    .command("merge <project> <branch>")
    .description("Merge an agent branch into main (or master)")
    .action(
      guard((project: string, branch: string) => {
        const ws = loadConfig(project).workspace;
        if (!ws || !isGitRepo(ws)) return fail(`${project} is not linked to a git folder.`);
        const r = mergeAgentBranch(ws, branch);
        if (!r.ok) return fail(r.detail);
        out(`Merged ${branch} into ${r.base}.`);
      }),
    );
  proj
    .command("edits <project> <mode>")
    .description("auto: writes and edits run at once. ask: each one asks you.")
    .action(
      guard((project: string, mode: string) => {
        if (mode !== "auto" && mode !== "ask") return fail("Mode must be auto or ask.");
        saveProjectConfig(home, { ...loadConfig(project), edits: mode });
        out(`Edits for ${project}: ${mode}`);
      }),
    );
  proj
    .command("budget <project> <jobTokens> <dayUsd>")
    .description("tokens one job may use, and dollars the project may spend per day (0 means no cap)")
    .action(
      guard((project: string, jobTokens: string, dayUsd: string) => {
        const tokens = jobTokens.trim() === "" ? NaN : Number(jobTokens);
        const usd = dayUsd.trim() === "" ? NaN : Number(dayUsd);
        if (!Number.isFinite(tokens) || !Number.isFinite(usd) || tokens < 0 || usd < 0) return fail("Budget must be two numbers of 0 or more.");
        saveProjectConfig(home, { ...loadConfig(project), budget: { jobTokens: tokens, dayUsd: usd } });
        out(`Budget for ${project}: ${tokens} tokens per job, $${usd} per day`);
      }),
    );
  proj
    .command("limits <project> <name> <value>")
    .description(`one limit the project keeps: ${LIMIT_NAMES.join(", ")}. 0 means no limit for stepsPerJob and parallelJobs.`)
    .action(
      guard((project: string, name: string, value: string) => {
        if (!(LIMIT_NAMES as string[]).includes(name)) return fail(`Limit must be one of ${LIMIT_NAMES.join(", ")}.`);
        const n = value.trim() === "" ? NaN : Number(value);
        if (!Number.isInteger(n) || n < 0) return fail("Limit must be a whole number of 0 or more.");
        const c = loadConfig(project);
        saveProjectConfig(home, { ...c, limits: { ...c.limits, [name]: n } });
        out(`Limit ${name} for ${project}: ${n}`);
      }),
    );
  for (const [name, key, what] of [["safe", "safeCommands", "command"], ["protect", "protectedPaths", "pattern"]] as const) {
    proj
      .command(`${name} <project> <action> <${what}>`)
      .description(name === "safe" ? "add or remove a command that runs without asking" : "add or remove a file pattern whose edits always ask")
      .action(
        guard((project: string, action: string, value: string) => {
          if (action !== "add" && action !== "remove") return fail("Action must be add or remove.");
          const c = loadConfig(project);
          const list = c[key].filter((v) => v !== value);
          if (action === "add") list.push(value);
          saveProjectConfig(home, { ...c, [key]: list });
          out(`${action === "add" ? "Added" : "Removed"} ${value}`);
        }),
      );
  }

  /** Parses --skills a,b. Every name must be a saved skill. undefined when the flag is absent. */
  const skillList = (raw: string | undefined): string[] | undefined => {
    if (raw === undefined) return undefined;
    const names = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const known = new Set(new SkillStore(home).list().map((s) => s.name));
    const missing = names.filter((n) => !known.has(n));
    if (missing.length > 0) return fail(`No skill ${missing.join(", ")}. Run: agentcity skill list`);
    return [...new Set(names)];
  };

  const skill = program.command("skill").description("Instruction files agents load when needed");
  skill
    .command("add <name>")
    .description("Create or replace a skill")
    .requiredOption("--description <text>", "one line: when to use it")
    .option("--text <instructions>")
    .option("--file <path>", "read the instructions from a file")
    .action(
      guard((name: string, o: { description: string; text?: string; file?: string }) => {
        if ((o.text === undefined) === (o.file === undefined)) return fail("Give --text or --file.");
        const body = o.file !== undefined ? fs.readFileSync(o.file, "utf8") : o.text!;
        new SkillStore(home).save(name, o.description, body);
        out(`Saved skill ${name}. Attach it with: agentcity agent edit <id> --skills ${name}`);
      }),
    );
  skill
    .command("list")
    .action(
      guard(() => {
        const all = new SkillStore(home).list();
        if (all.length === 0) return out("No skills.");
        for (const s of all) out(`${s.name}\t${s.description}`);
      }),
    );
  skill
    .command("show <name>")
    .action(
      guard((name: string) => {
        const s = new SkillStore(home).get(name);
        if (!s) return fail(`No skill ${name}.`);
        out(`${s.name}: ${s.description}`);
        out(s.body.trimEnd());
      }),
    );
  skill
    .command("remove <name>")
    .action(
      guard((name: string) => {
        if (!new SkillStore(home).remove(name)) return fail(`No skill ${name}.`);
        out(`Removed skill ${name}`);
      }),
    );

  const agent = program.command("agent").description("Manage agent profiles");
  const roles: AgentRole[] = ["boss", "manager", "worker"];
  const buildings: AgentBuilding[] = ["software", "visual"];
  agent
    .command("create <id>")
    .requiredOption("--name <name>")
    .addOption(new Option("--role <role>").choices(roles).default("worker"))
    .option("--model <model>", "model id", "claude-haiku-5-5")
    .addOption(new Option("--building <building>").choices(buildings).default("software"))
    .option("--persona <text>")
    .option("--persona-file <path>")
    .option("--skills <names>", "comma-separated skill names, empty to clear")
    .action(
      guard((id: string, o: { name: string; role: AgentRole; model: string; building: AgentBuilding; persona?: string; personaFile?: string; skills?: string }) => {
        const persona = personaFrom(o);
        if (persona === undefined) return fail("A persona is required: --persona <text> or --persona-file <path>.");
        checkModel(o.model);
        const p = new AgentStore(home).create({ id, name: o.name, role: o.role, model: o.model, building: o.building, persona, skills: skillList(o.skills) ?? [] });
        out(`Created agent ${p.id} (${p.name}) version ${p.version}`);
      }),
    );
  agent
    .command("edit <id>")
    .option("--name <name>")
    .addOption(new Option("--role <role>").choices(roles))
    .option("--model <model>")
    .addOption(new Option("--building <building>").choices(buildings))
    .option("--persona <text>")
    .option("--persona-file <path>")
    .option("--skills <names>", "comma-separated skill names, empty to clear")
    .action(
      guard((id: string, o: { name?: string; role?: AgentRole; model?: string; building?: AgentBuilding; persona?: string; personaFile?: string; skills?: string }) => {
        const persona = personaFrom(o);
        checkModel(o.model);
        const p = new AgentStore(home).update(id, { name: o.name, role: o.role, model: o.model, building: o.building, persona, skills: skillList(o.skills) });
        out(`Updated agent ${p.id} to version ${p.version}`);
      }),
    );
  agent
    .command("remove <id>")
    .description("delete the agent's profile, versions and notes, and take it off every project team")
    .action(
      guard((id: string) => {
        const store = new AgentStore(home);
        if (!store.get(id)) return fail(`No agent ${id}.`);
        const projects = path.join(home, "projects");
        for (const p of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
          const c = loadProjectConfig(home, p);
          if (!c.ok || !c.config.agents.includes(id)) continue;
          saveProjectConfig(home, { ...c.config, agents: c.config.agents.filter((a) => a !== id) });
        }
        store.remove(id);
        out(`Removed agent ${id}`);
      }),
    );
  agent
    .command("list")
    .action(
      guard(() => {
        const all = new AgentStore(home).list();
        if (all.length === 0) out("No agents.");
        for (const p of all) out(`${p.id}\t${p.name}\t${p.role}\t${p.model}\tv${p.version}\t${p.building}`);
      }),
    );
  agent
    .command("show <id>")
    .option("--version <n>", "show an old version")
    .action(
      guard((id: string, o: { version?: string }) => {
        const store = new AgentStore(home);
        let p;
        if (o.version !== undefined) {
          p = store.getVersion(id, Number(o.version));
          if (!p) return fail(`No version ${o.version} of agent ${id}.`);
        } else {
          p = store.get(id);
          if (!p) return fail(`No agent ${id}. Run: agentcity agent create ${id} ...`);
        }
        out(`id: ${p.id}\nname: ${p.name}\nrole: ${p.role}\nmodel: ${p.model}\nbuilding: ${p.building}\nversion: ${p.version}\nupdated: ${p.updatedAt}\npersona:\n${p.persona}`);
      }),
    );

  agent
    .command("memory <id>")
    .option("--clear", "ask, then empty the notes")
    .action(
      guard(async (id: string, o: { clear?: boolean }) => {
        if (!new AgentStore(home).get(id)) return fail(`No agent ${id}.`);
        const memory = new MemoryStore(home);
        if (o.clear) {
          io.output.write(`Clear notes for ${id}? [y/N] `);
          const reader = new LineReader(io.input, true);
          let answer: string;
          try {
            answer = (await reader.next().line).trim().toLowerCase();
          } finally {
            reader.close();
          }
          if (answer === "y") {
            memory.clear(id);
            out("Cleared.");
          } else {
            out("Kept.");
          }
          return;
        }
        const notes = memory.read(id);
        out(notes === "" ? "No notes." : redact(notes, Object.values(readSecrets(home))));
      }),
    );

  program
    .command("grant <project> <agent>")
    .action(
      guard((project: string, agentId: string) => {
        const config = loadConfig(project);
        if (!new AgentStore(home).get(agentId)) return fail(`No agent ${agentId}. Run: agentcity agent create ${agentId} ...`);
        if (!config.agents.includes(agentId)) config.agents.push(agentId);
        saveProjectConfig(home, config);
        out(`Granted ${agentId} to ${project}`);
      }),
    );
  program
    .command("revoke <project> <agent>")
    .action(
      guard((project: string, agentId: string) => {
        const config = loadConfig(project);
        config.agents = config.agents.filter((a) => a !== agentId);
        saveProjectConfig(home, config);
        out(`Revoked ${agentId} from ${project}`);
      }),
    );

  for (const [name, value] of [["kill", true], ["unkill", false]] as const) {
    program
      .command(`${name} <project>`)
      .action(
        guard((project: string) => {
          const config = loadConfig(project);
          saveProjectConfig(home, { ...config, killSwitch: value });
          out(`Kill switch ${value ? "on" : "off"} for ${project}`);
        }),
      );
  }

  program
    .command("log <project>")
    .option("--tail", "follow new rows")
    .option("--tree", "group rows by run, indented by delegation depth")
    .action(
      guard(async (project: string, o: { tail?: boolean; tree?: boolean }) => {
        if (o.tree && o.tail) return fail("Use --tree or --tail, not both.");
        projectDirs(home, project);
        const db = openDb(home);
        try {
          const log = new ActionLog(db, []);
          let after = 0;
          const rowLine = (r: ActionRow) =>
            `${r.id}\t${r.ts}\t${r.agentId}\t${r.type}\t${JSON.stringify(r.payload)}${r.usd ? `\t$${r.usd}` : ""}`;
          if (o.tree) {
            const rows = log.list(project);
            const parents = new Map<string, string | null>();
            const groups = new Map<string, ActionRow[]>();
            for (const r of rows) {
              if (r.runId === null) continue;
              if (!parents.has(r.runId)) parents.set(r.runId, r.parentRunId);
              const g = groups.get(r.runId);
              if (g) g.push(r);
              else groups.set(r.runId, [r]);
            }
            for (const r of rows) if (r.runId === null) out(rowLine(r));
            for (const [runId, group] of groups) {
              let depth = 0;
              const seen = new Set([runId]);
              for (let p = parents.get(runId) ?? null; p !== null && parents.has(p) && !seen.has(p); p = parents.get(p) ?? null) {
                seen.add(p);
                depth++;
              }
              out(`${"  ".repeat(depth)}run ${runId} ${group[0].agentId}`);
              for (const r of group) out(`${"  ".repeat(depth + 1)}${rowLine(r)}`);
            }
            return;
          }
          const print = () => {
            for (const r of log.list(project, after)) {
              after = r.id;
              out(rowLine(r));
            }
          };
          print();
          if (!o.tail) return;
          await new Promise<void>((resolve) => {
            const t = setInterval(print, 500);
            const off = register(() => {
              clearInterval(t);
              off();
              resolve();
            });
          });
        } finally {
          if (db.open) db.close();
        }
      }),
    );

  const connection = program.command("connection").description("OpenAI-compatible API connections");
  connection
    .command("add <name> <baseUrl>")
    .option("--input-price <usd>", "USD per million input tokens")
    .option("--output-price <usd>", "USD per million output tokens")
    .action(
      guard((name: string, baseUrl: string, o: { inputPrice?: string; outputPrice?: string }) => {
        if ((o.inputPrice === undefined) !== (o.outputPrice === undefined)) {
          return fail("Give both --input-price and --output-price, or neither.");
        }
        const num = (s: string): number => {
          const n = Number(s);
          if (!Number.isFinite(n) || n < 0) return fail(`Invalid price ${s}.`);
          return n;
        };
        const current = loadGlobalConfig(home).connections;
        if (current.some((c) => c.name === name)) return fail(`Connection ${name} already exists.`);
        const price = o.inputPrice !== undefined && o.outputPrice !== undefined
          ? { inputPerMTok: num(o.inputPrice), outputPerMTok: num(o.outputPrice) }
          : undefined;
        const parsed = ConnectionSchema.safeParse({ name, baseUrl: apiBaseUrl(baseUrl), ...(price ? { price } : {}) });
        if (!parsed.success) {
          return fail(`Invalid connection: name must match a-z, 0-9 and -, up to 24 characters; URL must be http or https.`);
        }
        saveConnections(home, [...current, parsed.data]);
        out(`Added connection ${name}. Set its key with: agentcity secrets set api-${name}`);
      }),
    );
  connection
    .command("list")
    .action(
      guard(() => {
        const all = loadGlobalConfig(home).connections;
        if (all.length === 0) return out("No connections.");
        const keys = readSecrets(home);
        for (const c of all) {
          const price = c.price ? `$${c.price.inputPerMTok}/$${c.price.outputPerMTok} per MTok` : "no price";
          out(`${c.name}\t${c.baseUrl}\t${price}\t${keys[`api-${c.name}`] ? "key set" : "no key"}`);
        }
      }),
    );
  connection
    .command("remove <name>")
    .action(
      guard((name: string) => {
        const all = loadGlobalConfig(home).connections;
        if (!all.some((c) => c.name === name)) return fail(`No connection ${name}.`);
        saveConnections(home, all.filter((c) => c.name !== name));
        // A re-added name may point at another host; it must not inherit this key.
        removeSecret(home, `api-${name}`);
        out(`Removed connection ${name}`);
      }),
    );

  const lmstudio = program.command("lmstudio").description("LM Studio on this computer (its key is the secret lmstudio)");
  lmstudio
    .command("url <url>")
    .description("Save the LM Studio server address, for example http://127.0.0.1:1234")
    .action(
      guard((url: string) => {
        try {
          saveLmStudioBaseUrl(home, url);
        } catch (e) {
          return fail((e as Error).message);
        }
        out(`LM Studio is at ${apiBaseUrl(url)}`);
      }),
    );

  const mcp = program.command("mcp").description("MCP servers agents can use");
  const pairs = (list: string[] | undefined, what: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of list ?? []) {
      const i = p.indexOf("=");
      if (i <= 0) return fail(`Invalid ${what} ${p}. Use NAME=VALUE.`);
      out[p.slice(0, i)] = p.slice(i + 1);
    }
    return out;
  };
  const collect = (v: string, prev: string[] = []) => [...prev, v];
  const servers = () => loadGlobalConfig(home).mcpServers;
  const findServer = (name: string): McpServer => {
    const s = servers().find((x) => x.name === name);
    return s ?? fail(`No MCP server ${name}. Run: agentcity mcp list`);
  };
  mcp
    .command("add <name> [command...]")
    .description("Add a stdio server (agentcity mcp add <name> -- <command> [args]) or an HTTP server (--url)")
    .option("--url <url>", "Streamable HTTP endpoint")
    .option("--env <NAME=VALUE>", "environment for a stdio server; use secret:<name> for keys", collect)
    .option("--header <NAME=VALUE>", "header for an HTTP server; use secret:<name> for keys", collect)
    .action(
      guard((name: string, command: string[], o: { url?: string; env?: string[]; header?: string[] }) => {
        const current = servers();
        if (current.some((s) => s.name === name)) return fail(`MCP server ${name} already exists.`);
        if ((command.length > 0) === (o.url !== undefined)) return fail("Give a command after -- or --url, not both.");
        const draft = {
          name,
          ...(command.length > 0 ? { command: command[0], args: command.slice(1) } : { url: o.url }),
          env: pairs(o.env, "env"),
          headers: pairs(o.header, "header"),
        };
        const literal = literalSecrets(draft);
        if (literal.length > 0) {
          return fail(`${literal.join(", ")} looks like a key. Store it with agentcity secrets set <name>, then use ${literal[0]}=secret:<name>.`);
        }
        const parsed = McpServerSchema.safeParse(draft);
        if (!parsed.success) return fail("Invalid MCP server: name must match a-z, 0-9 and -, up to 24 characters; --url must be a URL.");
        saveMcpServers(home, [...current, parsed.data]);
        out(`Added MCP server ${name}. Give a project its tools with: agentcity mcp grant <project> ${name}`);
      }),
    );
  mcp
    .command("list")
    .action(
      guard(() => {
        const all = servers();
        if (all.length === 0) return out("No MCP servers.");
        for (const s of all) {
          const where = s.command !== undefined ? [s.command, ...s.args].join(" ") : s.url!;
          out(`${s.name}\t${where}${s.allow.length ? `\tno ask: ${s.allow.join(", ")}` : ""}`);
        }
      }),
    );
  mcp
    .command("remove <name>")
    .action(
      guard((name: string) => {
        findServer(name);
        saveMcpServers(home, servers().filter((s) => s.name !== name));
        out(`Removed MCP server ${name}`);
      }),
    );
  mcp
    .command("tools <name>")
    .description("Start the server and list its tools")
    .action(
      guard(async (name: string) => {
        const server = findServer(name);
        let warned = "";
        const hub = await McpHub.connect([server], readSecrets(home), (l) => (warned = l), home);
        try {
          if (warned) return fail(warned);
          if (hub.tools.length === 0) return out("No tools.");
          for (const t of hub.tools) out(`${t.name}\t${t.tier === 1 ? "runs" : "asks"}\t${t.description.slice(0, 100)}`);
        } finally {
          await hub.close();
        }
      }),
    );
  for (const [verb, add] of [["allow", true], ["ask", false]] as const) {
    mcp
      .command(`${verb} <name> <tool>`)
      .description(add ? "let a tool run without asking" : "make a tool ask again")
      .action(
        guard((name: string, tool: string) => {
          const server = findServer(name);
          const allow = server.allow.filter((t) => t !== tool);
          if (add) allow.push(tool);
          saveMcpServers(home, servers().map((s) => (s.name === name ? { ...s, allow } : s)));
          out(add ? `${tool} on ${name} runs without asking.` : `${tool} on ${name} asks first.`);
        }),
      );
  }
  for (const [verb, add] of [["grant", true], ["revoke", false]] as const) {
    mcp
      .command(`${verb} <project> <name>`)
      .description(add ? "let the project's agents use the server" : "take the server away from the project")
      .action(
        guard((project: string, name: string) => {
          if (add) findServer(name);
          const config = loadConfig(project);
          const entry = mcpGrant(name);
          const tools = config.allowedTools.filter((t) => t !== entry);
          if (add) tools.push(entry);
          saveProjectConfig(home, { ...config, allowedTools: tools });
          out(add ? `${project} can use ${name}.` : `${project} can no longer use ${name}.`);
        }),
      );
  }

  const secrets = program.command("secrets").description("Provider keys");
  secrets
    .command("set <provider>")
    .action(
      guard(async (provider: string) => {
        const key = await readHidden(io, `Key for ${provider}: `);
        if (!key) return fail("No key entered.");
        setSecret(home, provider, key);
        out(`Stored key for ${provider}`);
      }),
    );

  program
    .command("run <project> <goal>")
    .requiredOption("--agent <id>", "agent id")
    .option("--model <id>", "model id for this run")
    .option("--ask-edits", "every file write and edit asks in this run")
    .action(
      guard(async (project: string, goal: string, o: { agent: string; model?: string; askEdits?: boolean }) => {
        projectDirs(home, project);
        checkModel(o.model);
        const profile = new AgentStore(home).get(o.agent);
        if (!profile) return fail(`No agent ${o.agent}. Run: agentcity agent create ${o.agent} ...`);
        const global = loadGlobalConfig(home);
        const keys = readSecrets(home);
        const secretValues = Object.values(keys);
        const db = openDb(home);
        const controller = new AbortController();
        const runner = new TreeRunner({
          home, project, db, secrets: secretValues, global, keys, providerOverride: deps.providerOverride,
          io, out, signal: controller.signal, approverFactory: deps.approverFactory, askEdits: o.askEdits,
        });

        let interrupted = false;
        let settle!: () => void;
        const runDone = new Promise<void>((r) => (settle = r));
        const unregister = register(async () => {
          interrupted = true;
          controller.abort();
          runner.cancelAll();
          await Promise.race([runDone, new Promise((r) => setTimeout(r, 2000))]);
          if (db.open) {
            runner.cancelAll();
            runner.markInterrupted();
            db.close();
          }
          exit(130);
        });

        let res: RunResult | undefined;
        try {
          res = await runner.run(profile.id, goal, { model: o.model });
        } finally {
          settle();
          unregister();
          runner.closeAll();
          if (!interrupted && db.open) db.close();
        }

        if (interrupted) return fail("Interrupted.", 130);
        if (res.reason === "no_provider") return fail(res.detail ?? "No provider.");
        if (res.reason === "workspace_dirty" || res.reason === "workspace_git") return fail(res.detail ?? res.reason);
        const lastError = runner.lastProviderError();
        if (res.reason === "provider_error" && lastError instanceof ProviderUnreachableError) {
          return fail(`Cannot reach LM Studio at ${lastError.baseUrl}. Is it running?`);
        }
        if (res.reason === "provider_error" && lastError instanceof Error) {
          return fail(`Run stopped: provider_error: ${lastError.message}`);
        }
        if (res.reason !== "done") return fail(`Run stopped: ${res.reason}`);
      }),
    );

  /** Serves the city until interrupted. The token stays the same across restarts, so open pages reconnect. */
  const serveCity = async (cityHome: string, portText: string, open: boolean): Promise<void> => {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return fail(`Invalid port ${portText}.`);
    const staticDir = deps.staticDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
    if (!fs.existsSync(path.join(staticDir, "index.html"))) return fail("client not built, run npm run build");
    let server;
    try {
      server = await startCityServer({ home: cityHome, port, staticDir, providerOverride: deps.providerOverride, token: cityToken(cityHome) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") return fail(`port ${port} in use, try --port`);
      throw e;
    }
    out(server.url);
    if (open) {
      const [cmd, args] =
        process.platform === "win32"
          ? ["cmd", ["/c", "start", "", server.url]]
          : process.platform === "darwin"
            ? ["open", [server.url]]
            : ["xdg-open", [server.url]];
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    }
    await new Promise<void>((resolve) => {
      const off = register(async () => {
        off();
        await server.close();
        exit(130);
        resolve();
      });
    });
  };

  program
    .command("city")
    .description("Open the city view in your browser")
    .option("--port <n>", "port on 127.0.0.1", "4321")
    .option("--no-open", "do not open a browser")
    .action(guard((o: { port: string; open: boolean }) => serveCity(home, o.port, o.open)));

  const claude = program.command("claude").description("Set up the Claude subscription (claude-sub/ models)");
  const consoleWindow = deps.openConsole ?? openConsole;
  const claudeNow = () => claudeStatus(loadGlobalConfig(home).claudePath);
  claude
    .command("status")
    .action(guard(() => out(`Claude subscription: ${describeClaude(claudeNow())}`)));
  claude
    .command("install")
    .description(`open a console window that runs ${CLAUDE_INSTALL}`)
    .action(
      guard(() => {
        if (claudeNow().path) return out("claude is already installed.");
        const r = consoleWindow("Install Claude Code", CLAUDE_INSTALL);
        if (!r.ok) return fail(r.error);
        out("Installing in a new window. When it ends, click Sign in.");
      }),
    );
  claude
    .command("signin")
    .description("open a console window that runs claude auth login, to sign in once")
    .action(
      guard(() => {
        const s = claudeNow();
        if (!s.path) return fail("claude is not installed. Click Install first.");
        const line = signinCommand(s.path);
        if (!line) return fail(`Unusual claude path: ${s.path}`);
        const r = consoleWindow("Sign in to Claude", line);
        if (!r.ok) return fail(r.error);
        out("Sign in in the new window. Your browser opens; approve, then close the window.");
      }),
    );

  const link = program.command("link").description(`Let the page start the city through ${LINK_URL} (Windows)`);
  const reg = deps.reg ?? runReg;
  const windowsOnly = () => {
    if ((deps.platform ?? process.platform) !== "win32") fail("The agentcity link works on Windows only.");
  };
  link
    .command("install")
    .description("register the link for this Windows user; it starts the city on this home and port")
    .option("--port <n>", "port the city uses", "4321")
    .action(
      guard((o: { port: string }) => {
        windowsOnly();
        const port = Number(o.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(`Invalid port ${o.port}.`);
        const main = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "main.js");
        const r = installLink(linkCommand({ node: process.execPath, main, home, port }), reg);
        if (!r.ok) return fail(`Could not register the link: ${r.out || "reg failed"}`);
        out(`Installed ${LINK_URL}: it starts the city on ${home}, port ${port}.`);
      }),
    );
  link
    .command("remove")
    .action(
      guard(() => {
        windowsOnly();
        const r = removeLink(reg);
        if (!r.ok) return fail(`Could not remove the link: ${r.out || "reg failed"}`);
        out("Removed the agentcity link.");
      }),
    );
  link
    .command("status")
    .action(
      guard(() => {
        windowsOnly();
        const command = linkStatus(reg);
        if (command === undefined) return fail("The agentcity link is not installed. Run: agentcity link install");
        out(`runs: ${command}`);
        const gone = missingPaths(command);
        if (gone.length > 0) return fail(`Missing: ${gone.join(", ")}. Run: agentcity link install`);
        out("ok");
      }),
    );
  link
    .command("open <url>")
    .description("what the link runs: start the city unless it already runs")
    .option("--home <dir>", "home folder the link was installed with")
    .option("--port <n>", "port", "4321")
    .action(
      guard(async (url: string, o: { home?: string; port: string }) => {
        if (!isLinkUrl(url)) return fail(`Not an Agent City link: ${url}`);
        if (await cityAnswers(Number(o.port))) return out(`The city already runs on port ${o.port}.`);
        await serveCity(o.home ?? home, o.port, false);
      }),
    );

  return program;
}

/** Runs the CLI and returns the exit code instead of exiting. */
export async function runCli(args: string[], deps: CliDeps = {}): Promise<number> {
  try {
    await buildProgram(deps).parseAsync(args, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
}
