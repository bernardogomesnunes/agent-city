import type { AgentView, BuildingId, CityState, HqConfig, PlotKind, RunView } from "@agentcity/world/shared";
import { placeInfo } from "../places.js";
import { el } from "./dom.js";
import type { HqDo } from "./hq-settings.js";
import { elapsed } from "./progress.js";

/** What a building view reads and does. */
export interface WorkContext {
  state: CityState | null;
  config: HqConfig | null;
  run: HqDo;
  /** Shows a command result that outlives the next redraw. */
  notify(text: string): void;
  now?: () => number;
}

const CAPABILITIES: Partial<Record<BuildingId, string[]>> = {
  software: [
    "Read and search files in the linked folder",
    "Edit and create files (protected files always ask)",
    "Run commands: npm, tests, builds, git",
    "Each run works on its own agent/ branch",
  ],
  visual: [
    "Write image prompts, slide outlines and video scripts",
    "Use MCP servers you give the project (Drive, YouTube, Figma)",
  ],
};

function section(parent: HTMLElement, title: string): HTMLElement {
  el("div", "ac-title hq-sub", title, parent);
  return el("div", "work-section", "", parent);
}

function agentRow(parent: HTMLElement, a: AgentView): void {
  const row = el("div", "hq-row", "", parent);
  el("div", "hq-row-head", `${a.name} · ${a.role} · ${a.activity}`, row);
  el("div", "hq-row-sub", [a.model, a.projectId].filter(Boolean).join(" · ") || "no run", row);
  if (a.lastText) el("div", "run-text", a.lastText.length > 200 ? `${a.lastText.slice(0, 200)}…` : a.lastText, row);
}

function runRows(parent: HTMLElement, runs: RunView[], now: number): void {
  if (runs.length === 0) el("div", "ac-empty", "nothing running", parent);
  for (const r of runs) {
    const row = el("div", "hq-row", "", parent);
    el("div", "hq-row-head", r.goal, row);
    el("div", "hq-row-sub", `${r.agents.join(" → ")} · ${r.projectId} · ${r.steps} steps · ${elapsed(now - Date.parse(r.startedAt))} · $${r.usd.toFixed(2)}`, row);
    if (r.lastTool) el("div", "run-tool", `now: ${r.lastTool}`, row);
  }
}

function button(parent: HTMLElement, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", `ac-button ${cls}`.trim(), label, parent);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function capabilities(parent: HTMLElement, id: BuildingId): void {
  const list = CAPABILITIES[id];
  if (!list) return;
  const s = section(parent, "What they can do");
  for (const c of list) el("div", "work-cap", `· ${c}`, s);
}

/** Agent branches per linked project, with Merge. Redraws `s` from scratch. */
export function renderMerge(s: HTMLElement, ctx: WorkContext): void {
  s.replaceChildren();
  const projects = (ctx.config?.projects ?? []).filter((p) => p.workspace);
  if (!ctx.config) el("div", "ac-empty", "loading…", s);
  else if (projects.length === 0) el("div", "ac-empty", "no linked folders; link one in HQ, Projects", s);
  for (const p of projects) {
    if (p.branches.length === 0) {
      el("div", "hq-row-sub", `${p.id}: nothing waiting${p.base ? ` (base ${p.base})` : ""}`, s);
      continue;
    }
    for (const b of p.branches) {
      const row = el("div", "hq-row work-branch", "", s);
      el("div", "hq-row-head", b.name, row);
      el("div", "hq-row-sub", `${p.id} · ${b.ahead} commit(s) · ${b.stat || "no file changes"}`, row);
      el("div", "hq-row-sub", b.subject, row);
      const merge = button(el("div", "hq-row-buttons", "", row), `Merge into ${p.base ?? "main"}`, () => {
        merge.disabled = true;
        merge.textContent = "merging…";
        void ctx.run(["project", "merge", p.id, b.name]).then((r) => ctx.notify(r.text));
      }, "approve");
    }
  }
}

/**
 * A frame showing a local web server, with buttons for the ports that answer.
 * Built once per visit so the page in the frame survives state updates.
 */
export function mountPreview(s: HTMLElement, scanPorts: () => void): { setPorts(ports: Array<{ port: number; title: string }>): void } {
  const bar = el("div", "hq-row-buttons", "", s);
  const url = el("input", "hq-inline work-url", "", bar);
  url.placeholder = "http://localhost:5173";
  const frame = el("iframe", "work-frame", "", s);
  frame.title = "preview";
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
  const go = (u: string) => {
    url.value = u;
    frame.src = u;
    open.href = u;
  };
  button(bar, "Show", () => go(normalUrl(url.value)));
  const open = el("a", "work-open", "new tab", bar);
  open.target = "_blank";
  open.rel = "noopener";
  button(bar, "Find servers", scanPorts);
  const ports = el("div", "hq-row-buttons", "", s);
  url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go(normalUrl(url.value));
  });
  const setPorts = (list: Array<{ port: number; title: string }>) => {
    ports.replaceChildren();
    if (list.length === 0) el("span", "ac-empty", "no local servers found", ports);
    for (const p of list) button(ports, `:${p.port}${p.title ? ` ${p.title.slice(0, 24)}` : ""}`, () => go(`http://localhost:${p.port}`));
    const first = list[0];
    if (first && !frame.getAttribute("src")) go(`http://localhost:${first.port}`);
  };
  setPorts([]);
  scanPorts();
  return { setPorts };
}

/** "5173" and "localhost:5173" become http://localhost:5173. Only local addresses pass. */
export function normalUrl(raw: string): string {
  let v = raw.trim();
  if (/^\d+$/.test(v)) v = `localhost:${v}`;
  if (!/^https?:\/\//.test(v)) v = `http://${v}`;
  try {
    const u = new URL(v);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? u.toString() : "about:blank";
  } catch {
    return "about:blank";
  }
}

const agentsIn = (ctx: WorkContext, building: string): AgentView[] => (ctx.state?.agents ?? []).filter((a) => a.building === building);
const runsOf = (ctx: WorkContext, ids: string[]): RunView[] => (ctx.state?.runs ?? []).filter((r) => r.agents.some((a) => ids.includes(a)));

/**
 * Renders one building's own view into `box`: who works there, what runs, and the tools of its trade.
 * The same view shows in the building and in HQ, tab Buildings.
 */
export function renderWork(box: HTMLElement, id: BuildingId, ctx: WorkContext): void {
  box.replaceChildren();
  const kind: PlotKind | undefined = ctx.state?.plots.find((p) => p.id === id)?.kind;
  const info = placeInfo(id, kind);
  el("div", "hq-note", info.purpose, box);
  const now = (ctx.now ?? Date.now)();

  if (id === "software" || id === "visual") {
    // The boss works from HQ; a house lists its workers, and its managers apart.
    const agents = agentsIn(ctx, id).filter((a) => a.role !== "boss");
    const workers = agents.filter((a) => a.role === "worker");
    const leads = agents.filter((a) => a.role === "manager");
    const s = section(box, id === "software" ? "Developers" : "Designers");
    if (workers.length === 0) el("div", "ac-empty", "nobody works here yet; create an agent in HQ", s);
    for (const a of workers) agentRow(s, a);
    if (leads.length > 0) {
      const m = section(box, "Managers");
      for (const a of leads) agentRow(m, a);
    }
    runRows(section(box, "Working on"), runsOf(ctx, agents.map((a) => a.id)), now);
    if (id === "visual") {
      const m = section(box, "Services");
      const servers = ctx.config?.mcpServers ?? [];
      if (servers.length === 0) el("div", "ac-empty", "no MCP servers; add one in HQ, MCP", m);
      for (const v of servers) el("div", "hq-row-sub", `${v.name}${v.oauth ? (v.signedIn ? " · signed in" : " · needs sign-in") : ""}`, m);
    }
    capabilities(box, id);
    return;
  }

  if (id === "director") {
    const agents = ctx.state?.agents ?? [];
    const runs = ctx.state?.runs ?? [];
    const spend = runs.reduce((sum, r) => sum + r.usd, 0);
    el("div", "hq-row-head", `${runs.length} running · ${ctx.state?.approvals.length ?? 0} approvals waiting · $${spend.toFixed(2)} in runs now`, box);
    for (const role of ["boss", "manager", "worker"] as const) {
      const s = section(box, role === "boss" ? "Boss" : role === "manager" ? "Managers" : "Workers");
      const list = agents.filter((a) => a.role === role);
      if (list.length === 0) el("div", "ac-empty", "none", s);
      for (const a of list) agentRow(s, a);
    }
    return;
  }

  if (id === "hq") {
    el("div", "hq-row-sub", "Walk to the front desk, or press H, for every setting.", box);
    return;
  }

  // Plots
  const builtBy = ctx.state?.plots.find((p) => p.id === id)?.builtBy;
  if (builtBy) el("div", "hq-row-sub", `Built by ${builtBy}.`, box);
  const c = ctx.config;
  if (kind === "library") {
    const s = section(box, "Skills");
    if (!c || c.skills.length === 0) el("div", "ac-empty", "no skills; add one in HQ, Skills", s);
    for (const k of c?.skills ?? []) {
      const users = c!.agents.filter((a) => a.skills.includes(k.name)).map((a) => a.name);
      el("div", "hq-row-head", k.name, s);
      el("div", "hq-row-sub", `${k.description} · used by ${users.join(", ") || "nobody"}`, s);
    }
  } else if (kind === "workshop") {
    const s = section(box, "Projects");
    for (const p of c?.projects ?? []) el("div", "hq-row-sub", `${p.id} · ${p.workspace ?? "sandbox"} · ${p.agents.join(", ") || "no agents"}`, s);
  } else if (kind === "exchange") {
    const r = section(box, "Runs now");
    runRows(r, ctx.state?.runs ?? [], now);
    const k = section(box, "API connections");
    for (const x of c?.connections ?? []) el("div", "hq-row-sub", `${x.name} · ${x.hasKey ? "key stored" : "no key"}`, k);
  } else if (kind === "studio") {
    const s = section(box, "MCP servers");
    for (const v of c?.mcpServers ?? []) el("div", "hq-row-sub", `${v.name} · ${v.where}${v.oauth ? (v.signedIn ? " · signed in" : " · needs sign-in") : ""}`, s);
  }
}
