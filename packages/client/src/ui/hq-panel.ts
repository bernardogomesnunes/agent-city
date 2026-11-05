import type { CityState, ClientMsg, HqConfig, HqStats, ModelGroup } from "@agentcity/world/shared";
import { el } from "./dom.js";
import { loadFolded, saveFolded } from "./fold.js";
import { HqSettings, type HqDo } from "./hq-settings.js";
import { renderActivity, renderAnalytics, renderPerformance } from "./hq-work.js";

/** Sends a message to the city. False when nothing was sent (offline). */
export type Send = (m: ClientMsg) => boolean;

export type Mode = "work" | "configure";
type BoxId =
  | "projects-panel" | "activity" | "performance" | "analytics"
  | "agents" | "projects" | "skills" | "connections" | "mcp";

/** Which containers each mode shows, per column, top to bottom. */
const LAYOUT: Record<Mode, { left: BoxId[]; right: BoxId[] }> = {
  work: { left: ["projects-panel"], right: ["activity", "performance", "analytics"] },
  configure: { left: ["agents", "projects", "skills"], right: ["connections", "mcp"] },
};
const TITLES: Record<BoxId, string> = {
  "projects-panel": "Projects", activity: "Activity",
  performance: "Performance · 7 days", analytics: "City · 7 days",
  agents: "Agents", projects: "Projects", skills: "Skills", connections: "APIs", mcp: "MCP servers",
};
const MODE_KEY = "agentcity.hqmode";

/** What HQ needs beyond sending messages. */
export interface HqHooks {
  run?: HqDo;
  /** Called each time HQ opens and on a mode switch, to ask the server for fresh settings and stats. */
  onOpen?(mode: Mode): void;
  /** Fills the Work Projects container. */
  mountProjects?(pane: HTMLElement): void;
  /** Called when HQ closes. */
  onClose?(): void;
}

/**
 * HQ: a mode switch at top centre (Work, Configure) and two fixed columns of foldable containers.
 * Work: projects, activity, performance, city numbers. Runs start from the dock's chat.
 * Configure: agents, projects, skills, APIs, MCP servers.
 * Opens on entering the HQ building, at its front desk, or on key H.
 */
export class HqPanel {
  readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly modeButtons = new Map<Mode, HTMLButtonElement>();
  private readonly boxes = new Map<BoxId, { root: HTMLElement; badge: HTMLElement; body: HTMLElement }>();
  private readonly settings: HqSettings;
  private state: CityState | null = null;
  private stats: HqStats | null = null;
  private mode_: Mode = loadMode();
  private open_ = false;

  constructor(
    parent: HTMLElement,
    private readonly send: Send,
    private readonly onOpenChange: (open: boolean) => void = () => undefined,
    private readonly hooks: HqHooks = {},
  ) {
    this.root = el("div", "hq-screen", "", parent);
    this.root.hidden = true;

    this.bar = el("div", "ac-box hq-bar", "", this.root);
    el("span", "hq-bar-title", "HQ", this.bar);
    const modes = el("div", "hq-modes", "", this.bar);
    modes.setAttribute("role", "tablist");
    for (const [m, label] of [["work", "Work"], ["configure", "Configure"]] as const) {
      const b = el("button", "hq-mode", label, modes);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => this.setMode(m));
      this.modeButtons.set(m, b);
    }
    const close = el("button", "panel-fold hq-close", "×", this.bar);
    close.type = "button";
    close.title = "Close (Esc)";
    close.setAttribute("aria-label", "Close HQ");
    close.addEventListener("click", () => this.close());

    const left = el("div", "hq-col hq-left", "", this.root);
    const right = el("div", "hq-col hq-right", "", this.root);
    for (const mode of ["work", "configure"] as const) {
      for (const id of LAYOUT[mode].left) this.box(left, id);
      for (const id of LAYOUT[mode].right) this.box(right, id);
    }

    const pane = (id: BoxId) => el("div", "hq-settings", "", this.body(id));
    const run: HqDo = hooks.run ?? (() => Promise.resolve({ code: 1, text: "offline" }));
    this.settings = new HqSettings(
      { agents: pane("agents"), projects: pane("projects"), connections: pane("connections"), mcp: pane("mcp"), skills: pane("skills") },
      run,
      () => this.send({ type: "models.list" }),
    );
    hooks.mountProjects?.(this.body("projects-panel"));

    this.applyMode();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  get mode(): Mode {
    return this.mode_;
  }

  open(mode?: Mode): void {
    if (mode && mode !== this.mode_) this.setMode(mode);
    if (this.open_) return;
    this.open_ = true;
    this.root.hidden = false;
    this.hooks.onOpen?.(this.mode_);
    if (this.mode_ === "configure") this.settings.showApis();
    this.onOpenChange(true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.hidden = true;
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.hooks.onClose?.();
    this.onOpenChange(false);
  }

  setMode(mode: Mode): void {
    this.mode_ = mode;
    saveMode(mode);
    this.applyMode();
    if (!this.open_) return;
    this.hooks.onOpen?.(mode);
    // Switching to Configure shows the APIs box, so its status is asked for.
    if (mode === "configure") this.settings.showApis();
  }

  /** Redraws everything that follows the city state. Forms keep what the player typed. */
  render(state: CityState | null): void {
    this.state = state;
    const s = state ?? { agents: [], plots: [], approvals: [], runs: [] };
    this.settings.setLive(s.agents);
    this.badge("agents", s.agents.length);

    // Performance shows agent names, which come with the state.
    if (this.stats) renderPerformance(this.body("performance"), this.stats, this.names());
  }

  setConfig(config: HqConfig): void {
    this.settings.setConfig(config);
    this.badge("projects", config.projects.length);
    this.badge("skills", config.skills.length);
    this.badge("connections", config.connections.length);
    this.badge("mcp", config.mcpServers.length);
  }

  setModels(groups: ModelGroup[]): void {
    this.settings.setModels(groups);
  }

  setStats(stats: HqStats): void {
    this.stats = stats;
    renderActivity(this.body("activity"), stats);
    renderPerformance(this.body("performance"), stats, this.names());
    renderAnalytics(this.body("analytics"), stats);
  }

  private names(): Map<string, string> {
    return new Map((this.state?.agents ?? []).map((a) => [a.id, a.name]));
  }

  private box(column: HTMLElement, id: BoxId): void {
    const root = el("section", `ac-box hq-box box-${id}`, "", column);
    const head = el("div", "hq-box-head", "", root);
    el("span", "hq-box-title", TITLES[id], head);
    const badge = el("span", "hq-badge", "", head);
    badge.hidden = true;
    const fold = el("button", "panel-fold", "", head);
    fold.type = "button";
    const body = el("div", `hq-box-body pane-${id}`, "", root);
    const setFolded = (folded: boolean) => {
      root.classList.toggle("folded", folded);
      body.hidden = folded;
      fold.textContent = folded ? "▸" : "▾";
      fold.setAttribute("aria-label", `${folded ? "Show" : "Fold"} ${TITLES[id]}`);
      fold.setAttribute("aria-expanded", String(!folded));
      saveFolded(`hq-${id}`, folded);
    };
    // The whole header folds, not only the arrow.
    head.addEventListener("click", () => setFolded(!root.classList.contains("folded")));
    setFolded(loadFolded(`hq-${id}`));
    this.boxes.set(id, { root, badge, body });
  }

  private body(id: BoxId): HTMLElement {
    return this.boxes.get(id)!.body;
  }

  private badge(id: BoxId, n: number, loud = false): void {
    const b = this.boxes.get(id)!.badge;
    b.hidden = n === 0;
    b.textContent = String(n);
    b.classList.toggle("loud", loud);
  }

  private applyMode(): void {
    const shown = new Set([...LAYOUT[this.mode_].left, ...LAYOUT[this.mode_].right]);
    for (const [id, b] of this.boxes) b.root.hidden = !shown.has(id);
    for (const [m, b] of this.modeButtons) {
      b.classList.toggle("active", m === this.mode_);
      b.setAttribute("aria-selected", String(m === this.mode_));
    }
  }
}

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "configure" ? "configure" : "work";
  } catch {
    return "work";
  }
}

function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // private window or blocked storage
  }
}
