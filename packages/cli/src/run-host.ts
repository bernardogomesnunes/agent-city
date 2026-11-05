import { PassThrough } from "node:stream";
import type Database from "better-sqlite3";
import type { Provider } from "@agentcity/core";
import { loadGlobalConfig, loadProjectConfig, type GlobalConfig } from "@agentcity/safety";
import { AgentStore } from "@agentcity/org";
import { TreeRunner } from "./tree-runner.js";
import { readSecrets } from "./secrets.js";
import type { WebApprovals } from "./web-approver.js";

export interface RunHostDeps {
  home: string;
  /** Shared by the caller. The host never closes it. */
  db: Database.Database;
  secrets: string[];
  keys: Record<string, string>;
  providerOverride?: Provider;
  approvals: WebApprovals;
  out: (line: string) => void;
  /** Called after a project's run or claim ends, so queued session turns can start. */
  onIdle?: (projectId: string) => void;
}

interface Active {
  controller: AbortController;
  runner: TreeRunner;
  done: Promise<void>;
}

const STOP_WAIT_MS = 2000;

/** Runs agent trees inside the city server, one at a time per project. */
export class RunHost {
  private readonly active = new Map<string, Active>();
  private readonly claimed = new Set<string>();

  constructor(private readonly d: RunHostDeps) {}

  busy(projectId: string): boolean {
    return this.active.has(projectId) || this.claimed.has(projectId);
  }

  /** Marks a project busy for a run that `start` does not launch (a terminal run). Undefined when busy. Call the result to release. */
  claim(projectId: string): (() => void) | undefined {
    if (this.busy(projectId)) return undefined;
    this.claimed.add(projectId);
    return () => {
      this.claimed.delete(projectId);
      this.d.onIdle?.(projectId);
    };
  }

  /** `report` gets one line when the run stops before or inside a model call (no_provider, provider_error). */
  start(projectId: string, agentId: string, goal: string, report?: (message: string) => void): { ok: true } | { ok: false; error: string } {
    if (this.busy(projectId)) return { ok: false, error: "project busy" };
    let global: GlobalConfig;
    try {
      this.refreshKeys();
      // Read per run, so connections added after the city started work.
      global = loadGlobalConfig(this.d.home);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!new AgentStore(this.d.home).get(agentId)) return { ok: false, error: `no agent ${agentId}` };
    let configured = false;
    try {
      configured = loadProjectConfig(this.d.home, projectId).ok;
    } catch {
      configured = false;
    }
    if (!configured) return { ok: false, error: `project ${projectId} missing` };

    const controller = new AbortController();
    const runner = new TreeRunner({
      home: this.d.home,
      project: projectId,
      db: this.d.db,
      secrets: this.d.secrets,
      global,
      keys: this.d.keys,
      providerOverride: this.d.providerOverride,
      io: { input: new PassThrough(), output: new PassThrough(), error: new PassThrough() },
      out: this.d.out,
      signal: controller.signal,
      approverFactory: this.d.approvals.factory,
    });
    const done = runner
      .run(agentId, goal)
      .then((res) => {
        const failed = ["no_provider", "provider_error", "workspace_dirty", "workspace_git"].includes(res.reason);
        const err = runner.lastProviderError();
        const detail = res.detail ?? (failed && err instanceof Error ? err.message : undefined);
        if (failed) report?.(`run stopped: ${res.reason}${detail ? `: ${detail}` : ""}`);
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        this.d.out(`run failed: ${message}`);
      })
      .finally(() => {
        runner.closeAll();
        this.active.delete(projectId);
        this.d.onIdle?.(projectId);
      });
    this.active.set(projectId, { controller, runner, done });
    return { ok: true };
  }

  /** Reads secrets.json again and updates the shared `keys` and `secrets` in place, so keys set in a normal terminal apply and get redacted. */
  private refreshKeys(): void {
    const fresh = readSecrets(this.d.home);
    Object.assign(this.d.keys, fresh);
    for (const v of Object.values(fresh)) if (!this.d.secrets.includes(v)) this.d.secrets.push(v);
  }

  /** Aborts the project's run and denies its waiting approvals. False when nothing runs there. */
  stop(projectId: string): boolean {
    const a = this.active.get(projectId);
    if (!a) return false;
    a.controller.abort();
    a.runner.cancelAll();
    return true;
  }

  /** Aborts every run, denies every waiting approval, waits up to 2000 ms. */
  async stopAll(): Promise<void> {
    const all = [...this.active.values()];
    for (const a of all) a.controller.abort();
    for (const a of all) a.runner.cancelAll();
    this.d.approvals.denyAll();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(all.map((a) => a.done)),
      new Promise<void>((r) => (timer = setTimeout(r, STOP_WAIT_MS))),
    ]);
    clearTimeout(timer);
  }
}
