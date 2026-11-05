import type { HqConfig, ModelGroup } from "@agentcity/world/shared";
import { bellOn, setBell } from "./alerts.js";
import { el } from "./dom.js";

/** Runs one agentcity command on the server for a form. Resolves with its exit code and output. */
export type HqDo = (argv: string[], input?: string) => Promise<{ code: number; text: string }>;

const ROLES = ["worker", "manager", "boss"];
const BUILDINGS = ["software", "visual"];
/** The six limits a project form sets, by the name the `project limits` command takes. */
type LimitName = keyof HqConfig["projects"][number]["limits"];
const LIMIT_FIELDS: ReadonlyArray<readonly [name: LimitName, label: string]> = [
  ["stepsPerJob", "Steps per job"],
  ["parallelJobs", "Parallel jobs"],
  ["reminders", "Reminders"],
  ["testFixes", "Test fixes"],
  ["sendBacks", "Send backs"],
  ["conflicts", "Conflicts"],
];
/** Model dropdown entries that are not model ids. */
const DEFAULT_MODEL = "";
const OTHER_MODEL = "\u0000other";

function button(parent: HTMLElement, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", `ac-button ${cls}`.trim(), label, parent);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function field<K extends "input" | "select" | "textarea">(parent: HTMLElement, label: string, tag: K): HTMLElementTagNameMap[K] {
  const wrap = el("label", "ac-field", "", parent);
  el("span", "ac-label", label, wrap);
  return el(tag, "", "", wrap);
}

function options(select: HTMLSelectElement, values: string[], chosen?: string): void {
  select.replaceChildren();
  for (const v of values) el("option", "", v, select).value = v;
  if (chosen !== undefined && values.includes(chosen)) select.value = chosen;
}

function checks(parent: HTMLElement, label: string, values: string[], chosen: string[]): () => string[] {
  const wrap = el("div", "ac-field", "", parent);
  el("span", "ac-label", label, wrap);
  if (values.length === 0) el("span", "ac-empty", "none yet", wrap);
  const boxes = values.map((v) => {
    const l = el("label", "ac-check", "", wrap);
    const c = el("input", "", "", l);
    c.type = "checkbox";
    c.checked = chosen.includes(v);
    l.append(` ${v}`);
    return [v, c] as const;
  });
  return () => boxes.filter(([, c]) => c.checked).map(([v]) => v);
}

/** Splits a command line on spaces, keeping "double quoted" parts together. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]!);
  return out;
}

/** NAME=VALUE lines to --flag NAME=VALUE pairs. Blank lines are skipped. */
export function pairFlags(flag: string, text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").flatMap((l) => [flag, l]);
}

/** A cap typed in a form: a number of 0 or more. Blank, negative or not a number is rejected. */
function isCap(text: string): boolean {
  return text.trim() !== "" && Number.isFinite(Number(text)) && Number(text) >= 0;
}

/** The project budget tag: "job 200k tokens · $1/day". Zero means no cap. */
function budgetLabel(b: { jobTokens: number; dayUsd: number }): string {
  const job = b.jobTokens === 0 ? "job no cap" : `job ${b.jobTokens >= 1000 ? `${b.jobTokens / 1000}k` : b.jobTokens} tokens`;
  const day = b.dayUsd === 0 ? "no cap/day" : `$${b.dayUsd}/day`;
  return `${job} · ${day}`;
}

type ViewPane = "agents" | "projects" | "connections" | "mcp" | "skills";

/**
 * The HQ settings tabs: projects, agents, connections, MCP and skills.
 * Each form turns into agentcity commands the server runs, so HQ and the terminal stay the same tool.
 */
export class HqSettings {
  private config: HqConfig | null = null;

  constructor(
    private readonly panes: { projects: HTMLElement; agents: HTMLElement; connections: HTMLElement; mcp: HTMLElement; skills: HTMLElement },
    private readonly run: HqDo,
    /** Asks the server for the models each source offers; the answer comes back through setModels. */
    private readonly requestModels: () => void = () => undefined,
  ) {
    for (const p of Object.values(panes)) el("div", "ac-empty", "loading…", p);
  }

  setConfig(c: HqConfig): void {
    this.config = c;
    this.redraw(this.panes.projects, () => this.renderProjects());
    this.redraw(this.panes.agents, () => this.renderAgents());
    this.redraw(this.panes.connections, () => this.renderConnections());
    this.redraw(this.panes.mcp, () => this.renderMcp());
    this.redraw(this.panes.skills, () => this.renderSkills());
  }

  /** The last command result per pane, shown again after a redraw. */
  private readonly messages = new Map<Element, { text: string; bad: boolean }>();
  /** Panes whose form just saved: the next redraw starts them empty. */
  private readonly saved = new Set<Element>();

  /**
   * Redraws a pane for new config and puts back what the player had typed, so a config push never eats a draft.
   * Key fields are never kept.
   */
  private redraw(pane: HTMLElement, render: () => void): void {
    const keep = this.saved.has(pane) ? new Map<string, string | boolean>() : fieldValues(pane);
    this.saved.delete(pane);
    render();
    for (const [key, input] of fieldsOf(pane)) {
      const v = keep.get(key);
      if (v === undefined || input.disabled) continue;
      if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = v === true;
      else if (input instanceof HTMLSelectElement) {
        if ([...input.options].some((o) => o.value === v)) input.value = v as string;
        // Fields that follow a select (the typed model id) show or hide again.
        input.dispatchEvent(new Event("change"));
      } else input.value = v as string;
    }
    const m = this.messages.get(pane);
    if (m) pane.prepend(el("pre", m.bad ? "hq-status bad" : "hq-status", m.text));
  }

  /** Runs commands in order, stops at the first failure, shows the output under the form. */
  private async steps(status: HTMLElement, list: Array<{ argv: string[]; input?: string }>): Promise<boolean> {
    const pane = Object.values(this.panes).find((p) => p.contains(status));
    status.textContent = "working…";
    status.className = "hq-status";
    const lines: string[] = [];
    const finish = (bad: boolean): boolean => {
      const text = lines.join("\n") || (bad ? "failed" : "done");
      status.textContent = text;
      status.className = bad ? "hq-status bad" : "hq-status";
      if (pane) {
        this.messages.set(pane, { text, bad });
        if (!bad) this.saved.add(pane);
        // A redraw may already have replaced `status`; the pane shows the result at its top.
        if (!pane.contains(status)) this.redraw(pane, () => this.renderPane(pane));
      }
      // A finished APIs step may change a source's status, so the models are asked again.
      if (pane === this.panes.connections) this.requestModels();
      return !bad;
    };
    for (const s of list) {
      const r = await this.run(s.argv, s.input);
      if (r.text) lines.push(r.text);
      if (r.code !== 0) return finish(true);
    }
    return finish(false);
  }

  private renderPane(pane: HTMLElement): void {
    if (!this.config) return;
    if (pane === this.panes.projects) this.renderProjects();
    else if (pane === this.panes.agents) this.renderAgents();
    else if (pane === this.panes.connections) this.renderConnections();
    else if (pane === this.panes.mcp) this.renderMcp();
    else this.renderSkills();
  }

  private renderProjects(): void {
    const c = this.config!;
    const pane = this.panes.projects;
    pane.replaceChildren();
    if (this.views.projects !== "list") return this.renderProjectForm();
    this.listBar(pane, `${c.projects.length} project(s)`, "Add", () => this.showView("projects", "new"));
    if (c.projects.length === 0) el("div", "ac-empty", "No projects yet. A project is a folder the agents work in.", pane);
    for (const p of c.projects) {
      const row = el("div", "hq-row", "", pane);
      const head = el("div", "hq-agent-head", "", row);
      el("span", "hq-row-head", p.id, head);
      el("span", `hw-tag${p.edits === "auto" ? "" : " warn"}`, `edits ${p.edits}`, head);
      el("span", "hw-tag", budgetLabel(p.budget), head);
      el("div", "hq-row-sub", `${p.workspace ?? "sandbox"} · agents ${p.agents.join(", ") || "none"} · MCP ${p.mcp.join(", ") || "none"}`, row);
      const bar = el("div", "hq-row-buttons", "", row);
      const status = el("pre", "hq-status", "", row);
      button(bar, p.edits === "auto" ? "Edits: ask first" : "Edits: auto", () => void this.steps(status, [{ argv: ["project", "edits", p.id, p.edits === "auto" ? "ask" : "auto"] }]));
      button(bar, "Limits", () => {
        if (!this.limitsOpen.delete(p.id)) this.limitsOpen.add(p.id);
        this.redraw(pane, () => this.renderPane(pane));
      });
      if (this.limitsOpen.has(p.id)) this.renderLimitsForm(row, p);
    }
  }

  /** Projects whose limits form is open. */
  private readonly limitsOpen = new Set<string>();

  /**
   * Eight number fields: the budget (job tokens, day USD) and the six limits. Save runs project budget, then project limits
   * for each limit. A bad number runs nothing.
   */
  private renderLimitsForm(row: HTMLElement, p: HqConfig["projects"][number]): void {
    const box = el("div", "hq-budget", "", row);
    const tokens = field(box, "Job token cap", "input");
    tokens.type = "number";
    tokens.min = "0";
    tokens.value = String(p.budget.jobTokens);
    const usd = field(box, "Day cap in USD", "input");
    usd.type = "number";
    usd.min = "0";
    usd.step = "any";
    usd.value = String(p.budget.dayUsd);
    const counts = LIMIT_FIELDS.map(([name, label]) => {
      const input = field(box, label, "input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.value = String(p.limits[name]);
      return [name, input] as const;
    });
    el("div", "hq-note", "0 means no limit for tokens, spend, steps and parallel jobs.", box);
    const status = el("pre", "hq-status", "", box);
    button(el("div", "hq-row-buttons", "", box), "Save", () => {
      if (!isCap(tokens.value) || !isCap(usd.value)) {
        status.className = "hq-status bad";
        status.textContent = "Budget must be two numbers of 0 or more.";
        return;
      }
      if (!counts.every(([, input]) => isCap(input.value) && Number.isInteger(Number(input.value)))) {
        status.className = "hq-status bad";
        status.textContent = "Limits must be whole numbers of 0 or more.";
        return;
      }
      const list: Array<{ argv: string[] }> = [{ argv: ["project", "budget", p.id, String(Number(tokens.value)), String(Number(usd.value))] }];
      for (const [name, input] of counts) list.push({ argv: ["project", "limits", p.id, name, String(Number(input.value))] });
      void this.steps(status, list).then((ok) => {
        // Saved: the form closes and the result shows at the top of the list.
        if (!ok) return;
        this.limitsOpen.delete(p.id);
        this.savedBack("projects");
      });
    }, "approve");
  }

  private renderProjectForm(): void {
    const pane = this.panes.projects;
    this.formTop(pane, "New project", () => this.showView("projects", "list"));
    const id = field(pane, "Project id", "input");
    id.placeholder = "e.g. my-site";
    const folder = field(pane, "Folder (optional)", "input");
    folder.placeholder = "C:\\code\\my-site, empty for a sandbox";
    const status = el("pre", "hq-status", "", pane);
    const bar = el("div", "hq-row-buttons", "", pane);
    button(bar, "Create project", () => {
      const argv = ["init", id.value.trim()];
      if (folder.value.trim()) argv.push("--path", folder.value.trim());
      void this.steps(status, [{ argv }]).then((ok) => ok && this.savedBack("projects"));
    }, "approve");
    button(bar, "Cancel", () => this.showView("projects", "list"));
  }

  /**
   * Every pane shows a list or a form: "list", "new", or for agents the id being edited.
   * A config push redraws the current view and keeps what was typed.
   */
  private readonly views: Record<ViewPane, string> = { agents: "list", projects: "list", connections: "list", mcp: "list", skills: "list" };
  /** What each agent is doing now, from the city state. */
  private live: Array<{ id: string; name: string; role: string; activity: string }> = [];

  /** New city state: the list shows each agent's activity. A form being filled stays as it is. */
  setLive(agents: Array<{ id: string; name: string; role: string; activity: string }>): void {
    this.live = agents;
    if (this.views.agents === "list") this.renderAgentList();
  }

  /** Switches a pane between its list and a form. The form starts empty and the last result clears. */
  private showView(key: ViewPane, view: string): void {
    const pane = this.panes[key];
    this.views[key] = view;
    this.messages.delete(pane);
    this.saved.add(pane);
    this.redraw(pane, () => this.renderPane(pane));
  }

  /** After a form saved: back to the list, with the command result on top. */
  private savedBack(key: ViewPane): void {
    const pane = this.panes[key];
    const m = this.messages.get(pane);
    this.showView(key, "list");
    if (m) {
      this.messages.set(pane, m);
      pane.prepend(el("pre", m.bad ? "hq-status bad" : "hq-status", m.text));
    }
  }

  private listBar(pane: HTMLElement, count: string, add: string, onAdd: () => void): void {
    const bar = el("div", "hq-pane-bar", "", pane);
    el("span", "hq-row-sub", count, bar);
    button(bar, add, onAdd, "approve");
  }

  private formTop(pane: HTMLElement, title: string, back: () => void): void {
    const top = el("div", "hq-pane-bar", "", pane);
    button(top, "‹ Back", back, "hq-back");
    el("span", "ac-title", title, top);
  }

  private renderAgents(): void {
    if (this.views.agents === "list") this.renderAgentList();
    else this.renderAgentForm();
  }

  /** The form the models were last asked for, so a redraw does not ask again. */
  private modelsAskedFor = "";

  private renderAgentList(): void {
    this.modelsAskedFor = "";
    const pane = this.panes.agents;
    pane.replaceChildren();
    const c = this.config;
    const activity = new Map(this.live.map((a) => [a.id, a.activity]));
    const bar = el("div", "hq-pane-bar", "", pane);
    el("span", "hq-row-sub", `${(c?.agents ?? this.live).length} agent(s)`, bar);
    if (c) button(bar, "Add", () => this.showView("agents", "new"), "approve");
    const rows = c?.agents ?? this.live.map((a) => ({ ...a, model: "", building: "", skills: [] as string[] }));
    if (rows.length === 0) el("div", "ac-empty", "No agents yet.", pane);
    for (const a of rows) {
      const row = el("div", "hq-row hq-agent", "", pane);
      const head = el("div", "hq-agent-head", "", row);
      el("span", "hq-row-head", `${a.name} (${a.id})`, head);
      const now = activity.get(a.id) ?? "away";
      el("span", `hw-tag${now === "idle" || now === "away" ? "" : " live"}`, now, head);
      if (c) button(head, "Edit", () => this.showView("agents", a.id));
      const where = [a.role, a.building, a.model, a.skills.length ? `skills ${a.skills.join(", ")}` : ""].filter(Boolean).join(" · ");
      el("div", "hq-row-sub", where, row);
      if (c) {
        const status = el("pre", "hq-status", "", row);
        // Notes cannot come back, so this one asks first.
        button(el("div", "hq-row-buttons", "", row), "Remove", () => {
          if (window.confirm(`Delete ${a.name}? This removes the profile, versions and notes.`)) void this.steps(status, [{ argv: ["agent", "remove", a.id] }]);
        }, "deny");
      }
    }
    const m = this.messages.get(pane);
    if (m) pane.prepend(el("pre", m.bad ? "hq-status bad" : "hq-status", m.text));
  }

  /** Models per source, from the server. Null until the first answer. */
  private models: ModelGroup[] | null = null;

  /** New model list: an open agent form redraws its dropdown and keeps what was typed. */
  setModels(groups: ModelGroup[]): void {
    this.models = groups;
    if (this.config && this.views.agents !== "list") this.redraw(this.panes.agents, () => this.renderAgents());
    // The APIs pane shows each source's status. A redraw keeps what was typed and never asks for models.
    if (this.config) this.redraw(this.panes.connections, () => this.renderConnections());
  }

  /** The APIs pane shows: ask for the models once, so each source's status is current. */
  showApis(): void {
    this.requestModels();
  }

  /** What a source's status tag says, from the last models answer. `checking` until its group arrives. */
  private modelStatus(label: string): { text: string; live: boolean; models: string[] } {
    const g = this.models?.find((x) => x.label === label);
    if (!g) return { text: "checking", live: false, models: [] };
    if (g.error) return { text: g.error, live: false, models: g.models };
    if (g.models.length > 0) return { text: `connected, ${g.models.length} models`, live: true, models: g.models };
    return { text: "connected, no models", live: false, models: [] };
  }

  private statusTag(parent: HTMLElement, label: string): void {
    const s = this.modelStatus(label);
    el("span", `hw-tag ${s.live ? "live" : "warn"}`, s.text, parent);
  }

  /** The model ids a source lists, in a fold that starts closed. */
  private modelFold(parent: HTMLElement, models: string[]): void {
    const fold = el("details", "hq-models", "", parent);
    el("summary", "", `${models.length} model(s)`, fold);
    for (const m of models) el("div", "hq-row-sub", m, fold);
  }

  /**
   * The model dropdown: every model each source lists, grouped by source, plus "other" for an id typed by hand.
   * A source that cannot be reached shows its error as a greyed line. Returns the chosen id ("" keeps the default).
   */
  private modelPicker(pane: HTMLElement, current: string): () => string {
    const select = field(pane, "Model", "select");
    const groups = this.models ?? [];
    if (!current) el("option", "", "default model", select).value = DEFAULT_MODEL;
    if (current && !groups.some((g) => g.models.includes(current))) el("option", "", current, select).value = current;
    if (this.models === null) el("option", "", "loading models…", select).disabled = true;
    for (const g of groups) {
      const og = el("optgroup", "", "", select);
      og.label = g.label;
      if (g.error) el("option", "", g.error, og).disabled = true;
      for (const m of g.models) el("option", "", m, og).value = m;
    }
    el("option", "", "other (type the id)", select).value = OTHER_MODEL;
    select.value = current;
    const other = field(pane, "Model id", "input");
    other.placeholder = "lmstudio/<model>, claude-sub/<alias>, api/<connection>/<model>";
    const wrap = other.closest<HTMLElement>(".ac-field")!;
    const sync = () => (wrap.hidden = select.value !== OTHER_MODEL);
    select.addEventListener("change", sync);
    sync();
    return () => (select.value === OTHER_MODEL ? other.value.trim() : select.value);
  }

  private renderAgentForm(): void {
    // The list may have changed since the last form (a new API, LM Studio started), so ask each time.
    if (this.views.agents !== this.modelsAskedFor) {
      this.modelsAskedFor = this.views.agents;
      this.requestModels();
    }
    const c = this.config!;
    const pane = this.panes.agents;
    pane.replaceChildren();
    const current = c.agents.find((a) => a.id === this.views.agents);
    this.formTop(pane, current ? `Edit ${current.name}` : "New agent", () => this.showView("agents", "list"));
    const id = field(pane, "Id", "input");
    id.placeholder = "a-z, 0-9 and -";
    id.value = current?.id ?? "";
    id.disabled = current !== undefined;
    const name = field(pane, "Name", "input");
    name.value = current?.name ?? "";
    const role = field(pane, "Role", "select");
    options(role, ROLES, current?.role);
    const building = field(pane, "Works in", "select");
    options(building, BUILDINGS, current?.building);
    const model = this.modelPicker(pane, current?.model ?? "");
    const persona = field(pane, "Persona", "textarea");
    persona.rows = 4;
    persona.placeholder = "Who the agent is and how it works.";
    persona.value = current?.persona ?? "";
    const skills = checks(pane, "Skills", c.skills.map((s) => s.name), current?.skills ?? []);
    const had = c.projects.filter((p) => current && p.agents.includes(current.id)).map((p) => p.id);
    const projects = checks(pane, "Works on projects", c.projects.map((p) => p.id), had);
    const status = el("pre", "hq-status", "", pane);
    const bar = el("div", "hq-row-buttons", "", pane);
    button(bar, current ? "Save" : "Create agent", () => {
      const agentId = id.value.trim();
      const who = name.value.trim();
      if (!/^[a-z0-9-]{1,40}$/.test(agentId) || !who) {
        status.className = "hq-status bad";
        status.textContent = "Give an id (a-z, 0-9 and -) and a name.";
        return;
      }
      // An empty persona gets a plain one the player can edit later.
      const about = persona.value.trim() || `You are ${who}, a ${role.value} in the ${building.value} house.`;
      const base = ["--name", who, "--role", role.value, "--building", building.value, "--persona", about, "--skills", skills().join(",")];
      if (model()) base.push("--model", model());
      const list: Array<{ argv: string[] }> = [{ argv: current ? ["agent", "edit", agentId, ...base] : ["agent", "create", agentId, ...base] }];
      const want = projects();
      for (const p of want) if (!had.includes(p)) list.push({ argv: ["grant", p, agentId] });
      for (const p of had) if (!want.includes(p)) list.push({ argv: ["revoke", p, agentId] });
      void this.steps(status, list).then((ok) => {
        // Saved: back to the list, which shows the result at its top.
        if (ok) this.savedBack("agents");
      });
    }, "approve");
    button(bar, "Cancel", () => this.showView("agents", "list"));
  }

  private keyForm(parent: HTMLElement, secretName: string, label: string): void {
    const wrap = el("div", "hq-key", "", parent);
    const key = field(wrap, label, "input");
    key.type = "password";
    key.autocomplete = "off";
    key.placeholder = "paste the key; it is stored and never shown again";
    const status = el("pre", "hq-status", "", wrap);
    button(wrap, "Save key", () => {
      const v = key.value.trim();
      key.value = "";
      if (v) void this.steps(status, [{ argv: ["secrets", "set", secretName], input: v }]);
    });
  }

  private renderConnections(): void {
    const c = this.config!;
    const pane = this.panes.connections;
    pane.replaceChildren();
    if (this.views.connections !== "list") return this.renderConnectionForm();
    this.listBar(pane, `${c.connections.length} API(s)`, "Add", () => this.showView("connections", "new"));
    this.bellToggle(pane);
    // The Claude subscription runs the local claude program on the player's own sign-in: no key, two one-time steps.
    const sub = el("div", "hq-claude", "", pane);
    const subHead = el("div", "hq-agent-head", "", sub);
    el("span", "hq-row-head", "Claude subscription", subHead);
    const ready = c.claude.path !== null && c.claude.signedIn !== false;
    el("span", `hw-tag ${ready ? "live" : "warn"}`, c.claude.text, subHead);
    el("div", "hq-row-sub", "models claude-sub/<opus|sonnet|haiku>, on your Claude plan", sub);
    const subStatus = el("pre", "hq-status", "", sub);
    const subButtons = el("div", "hq-row-buttons", "", sub);
    if (c.claude.path === null) button(subButtons, "Install", () => void this.steps(subStatus, [{ argv: ["claude", "install"] }]), "approve");
    else if (c.claude.signedIn === false) button(subButtons, "Sign in", () => void this.steps(subStatus, [{ argv: ["claude", "signin"] }]), "approve");
    button(subButtons, "Check again", () => void this.steps(subStatus, [{ argv: ["claude", "status"] }]));
    this.renderLmStudio(pane, c.lmStudio);
    if (c.connections.length === 0) el("div", "ac-empty", "No other APIs yet.", pane);
    for (const k of c.connections) {
      const row = el("div", "hq-row", "", pane);
      const head = el("div", "hq-agent-head", "", row);
      el("span", "hq-row-head", k.name, head);
      this.statusTag(head, `API: ${k.name}`);
      el("div", "hq-row-sub", `${k.baseUrl} · models api/${k.name}/<model>`, row);
      this.modelFold(row, this.modelStatus(`API: ${k.name}`).models);
      this.keyForm(row, `api-${k.name}`, k.hasKey ? "Replace key" : "Key");
      const status = el("pre", "hq-status", "", row);
      button(el("div", "hq-row-buttons", "", row), "Remove", () => void this.steps(status, [{ argv: ["connection", "remove", k.name] }]), "deny");
    }
  }

  /** LM Studio on this computer: its status, model ids, server address, key and a check. Sits under the Claude card. */
  private renderLmStudio(pane: HTMLElement, lm: HqConfig["lmStudio"]): void {
    const card = el("div", "hq-claude", "", pane);
    const head = el("div", "hq-agent-head", "", card);
    el("span", "hq-row-head", "LM Studio", head);
    this.statusTag(head, "LM Studio");
    el("div", "hq-row-sub", "models lmstudio/<model>, local and free", card);
    this.modelFold(card, this.modelStatus("LM Studio").models);
    const urlStatus = el("pre", "hq-status", "", card);
    const url = field(card, "Base URL", "input");
    url.value = lm.baseUrl;
    button(el("div", "hq-row-buttons", "", card), "Save", () => void this.steps(urlStatus, [{ argv: ["lmstudio", "url", url.value.trim()] }]), "approve");
    this.keyForm(card, "lmstudio", lm.hasKey ? "Replace key" : "Key");
    button(el("div", "hq-row-buttons", "", card), "Check again", () => this.requestModels());
  }

  /** The alert sound for new requests. It keeps the setting key the top bar's bell used. */
  private bellToggle(pane: HTMLElement): void {
    const wrap = el("label", "hq-bell", "", pane);
    const box = el("input", "hq-bell-box", "", wrap);
    box.type = "checkbox";
    box.checked = bellOn();
    box.addEventListener("change", () => setBell(box.checked));
    wrap.append(" Bell: a tone when something new waits in the Inbox");
  }

  private renderConnectionForm(): void {
    const pane = this.panes.connections;
    this.formTop(pane, "New API", () => this.showView("connections", "list"));
    el("div", "hq-note", "Any OpenAI-compatible API. Store its key in the list after adding it. Local servers usually need a key too, if their token setting is on.", pane);
    const name = field(pane, "Name", "input");
    name.placeholder = "e.g. groq";
    const url = field(pane, "Base URL", "input");
    url.placeholder = "https://api.groq.com/openai/v1";
    const inP = field(pane, "USD per million input tokens (optional)", "input");
    const outP = field(pane, "USD per million output tokens (optional)", "input");
    const status = el("pre", "hq-status", "", pane);
    const bar = el("div", "hq-row-buttons", "", pane);
    button(bar, "Add API", () => {
      const argv = ["connection", "add", name.value.trim(), url.value.trim()];
      if (inP.value.trim() || outP.value.trim()) argv.push("--input-price", inP.value.trim(), "--output-price", outP.value.trim());
      void this.steps(status, [{ argv }]).then((ok) => ok && this.savedBack("connections"));
    }, "approve");
    button(bar, "Cancel", () => this.showView("connections", "list"));
  }

  private renderMcp(): void {
    const c = this.config!;
    const pane = this.panes.mcp;
    pane.replaceChildren();
    if (this.views.mcp !== "list") return this.renderMcpForm();
    this.listBar(pane, `${c.mcpServers.length} server(s)`, "Add", () => this.showView("mcp", "new"));
    if (c.mcpServers.length === 0) el("div", "ac-empty", "No MCP servers yet. They give agents tools for Gmail, Drive, GitHub and more.", pane);
    for (const s of c.mcpServers) {
      const row = el("div", "hq-row", "", pane);
      const head = el("div", "hq-agent-head", "", row);
      el("span", "hq-row-head", s.name, head);
      if (s.oauth) el("span", `hw-tag ${s.signedIn ? "live" : "warn"}`, s.signedIn ? "signed in" : "not signed in", head);
      const used = c.projects.filter((p) => p.mcp.includes(s.name)).map((p) => p.id);
      el("div", "hq-row-sub", `${s.where} · projects ${used.join(", ") || "none"} · ${s.allow.length} tool(s) run without asking`, row);
      const bar = el("div", "hq-row-buttons", "", row);
      const status = el("pre", "hq-status", "", row);
      const tools = el("div", "hq-tools", "", row);
      if (s.oauth) button(bar, s.signedIn ? "Sign in again" : "Sign in", () => void this.steps(status, [{ argv: ["mcp", "signin", s.name] }]));
      button(bar, "Tools", () => void this.showTools(s.name, s.allow, tools, status));
      const proj = el("select", "hq-inline", "", bar);
      options(proj, c.projects.map((p) => p.id));
      button(bar, "Give to project", () => void this.steps(status, [{ argv: ["mcp", "grant", proj.value, s.name] }]));
      button(bar, "Remove", () => void this.steps(status, [{ argv: ["mcp", "remove", s.name] }]), "deny");
    }
  }

  private renderMcpForm(): void {
    const pane = this.panes.mcp;
    this.formTop(pane, "New MCP server", () => this.showView("mcp", "list"));
    el("div", "hq-note", "Every tool asks before it runs unless you allow it.", pane);
    const name = field(pane, "Name", "input");
    name.placeholder = "e.g. github";
    const kind = field(pane, "Runs", "select");
    options(kind, ["on the web (URL, sign in with the service)", "on this computer (command)"]);
    const where = field(pane, "URL or command", "input");
    where.placeholder = "https://example.com/mcp  or  npx -y @modelcontextprotocol/server-github";
    const env = field(pane, "Settings, one NAME=VALUE per line (keys: NAME=secret:<key name>)", "textarea");
    env.rows = 2;
    const status = el("pre", "hq-status", "", pane);
    const bar = el("div", "hq-row-buttons", "", pane);
    button(bar, "Add server", () => {
      const web = kind.selectedIndex === 0;
      const argv = ["mcp", "add", name.value.trim(), ...pairFlags(web ? "--header" : "--env", env.value)];
      if (web) argv.push("--url", where.value.trim());
      else argv.push("--", ...splitCommand(where.value.trim()));
      void this.steps(status, [{ argv }]).then((ok) => ok && this.savedBack("mcp"));
    }, "approve");
    button(bar, "Cancel", () => this.showView("mcp", "list"));
    el("div", "ac-title hq-sub", "Store a key for a server", pane);
    const keyName = field(pane, "Key name (the <key name> in secret:<key name>)", "input");
    keyName.placeholder = "e.g. github";
    const keyBox = el("div", "", "", pane);
    keyName.addEventListener("change", () => {
      keyBox.replaceChildren();
      if (keyName.value.trim()) this.keyForm(keyBox, keyName.value.trim(), "Key");
    });
  }

  private async showTools(server: string, allow: string[], box: HTMLElement, status: HTMLElement): Promise<void> {
    status.textContent = "starting the server…";
    const r = await this.run(["mcp", "tools", server]);
    status.textContent = r.code === 0 ? "" : r.text;
    box.replaceChildren();
    if (r.code !== 0) return;
    const prefix = `mcp__${server}__`;
    for (const line of r.text.split("\n")) {
      const [full, , desc] = line.split("\t");
      if (!full?.startsWith(prefix)) continue;
      const tool = full.slice(prefix.length);
      const row = el("div", "hq-tool", "", box);
      const runs = allow.includes(tool);
      el("span", "", `${tool} · ${runs ? "runs" : "asks"} · ${desc ?? ""}`, row);
      button(row, runs ? "Ask first" : "Allow", () => {
        void this.steps(status, [{ argv: ["mcp", runs ? "ask" : "allow", server, tool] }]).then(() => {
          if (runs) allow.splice(allow.indexOf(tool), 1);
          else allow.push(tool);
          void this.showTools(server, allow, box, status);
        });
      });
    }
  }

  private renderSkills(): void {
    const c = this.config!;
    const pane = this.panes.skills;
    pane.replaceChildren();
    if (this.views.skills !== "list") return this.renderSkillForm();
    this.listBar(pane, `${c.skills.length} skill(s)`, "Add", () => this.showView("skills", "new"));
    if (c.skills.length === 0) el("div", "ac-empty", "No skills yet. A skill is instructions an agent loads when a task needs them.", pane);
    for (const s of c.skills) {
      const row = el("div", "hq-row", "", pane);
      const head = el("div", "hq-agent-head", "", row);
      el("span", "hq-row-head", s.name, head);
      const users = c.agents.filter((a) => a.skills.includes(s.name)).length;
      el("span", "hw-tag", `${users} agent(s)`, head);
      el("div", "hq-row-sub", s.description, row);
      const status = el("pre", "hq-status", "", row);
      button(el("div", "hq-row-buttons", "", row), "Remove", () => void this.steps(status, [{ argv: ["skill", "remove", s.name] }]), "deny");
    }
  }

  private renderSkillForm(): void {
    const pane = this.panes.skills;
    this.formTop(pane, "New skill", () => this.showView("skills", "list"));
    el("div", "hq-note", "A skill with an existing name replaces it. Attach skills to agents in Agents.", pane);
    const name = field(pane, "Name", "input");
    name.placeholder = "e.g. cover-letter";
    const desc = field(pane, "When to use it (one line)", "input");
    const body = field(pane, "Instructions", "textarea");
    body.rows = 6;
    const status = el("pre", "hq-status", "", pane);
    const bar = el("div", "hq-row-buttons", "", pane);
    button(bar, "Save skill", () => {
      void this.steps(status, [{ argv: ["skill", "add", name.value.trim(), "--description", desc.value.trim(), "--text", body.value] }])
        .then((ok) => ok && this.savedBack("skills"));
    }, "approve");
    button(bar, "Cancel", () => this.showView("skills", "list"));
  }
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Form fields under a pane keyed by their label (and box text for checkboxes), numbered when a label repeats. */
function fieldsOf(pane: HTMLElement): Array<[string, Field]> {
  const seen = new Map<string, number>();
  const out: Array<[string, Field]> = [];
  for (const input of pane.querySelectorAll<Field>("input, select, textarea")) {
    if (input instanceof HTMLInputElement && input.type === "password") continue;
    const label = input.closest(".ac-field")?.querySelector(".ac-label")?.textContent ?? "";
    const box = input instanceof HTMLInputElement && input.type === "checkbox" ? `:${input.parentElement?.textContent ?? ""}` : "";
    const base = label + box;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push([`${base}#${n}`, input]);
  }
  return out;
}

function fieldValues(pane: HTMLElement): Map<string, string | boolean> {
  const m = new Map<string, string | boolean>();
  for (const [key, input] of fieldsOf(pane)) m.set(key, input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value);
  return m;
}
