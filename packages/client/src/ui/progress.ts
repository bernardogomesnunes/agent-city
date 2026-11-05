import type { RunView } from "@agentcity/world/shared";
import { el } from "./dom.js";
import type { Send } from "./hq-panel.js";

/** "42s", "3m 05s", "1h 02m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Top right: one card per run in progress with its goal, agents, step count, last tool, last result and cost.
 * Stop aborts the run and denies its waiting approvals. Hidden when nothing runs.
 */
export class ProgressPanel {
  readonly root: HTMLElement;
  private runs: RunView[] = [];

  constructor(parent: HTMLElement, private readonly send: Send, private readonly now: () => number = Date.now) {
    this.root = el("div", "ac-box progress-panel", "", parent);
    this.root.hidden = true;
  }

  /** True while at least one run shows. */
  get visible(): boolean {
    return !this.root.hidden;
  }

  render(runs: RunView[]): void {
    this.runs = runs;
    this.root.replaceChildren();
    this.root.hidden = runs.length === 0;
    if (runs.length === 0) return;
    el("div", "ac-title", runs.length === 1 ? "Working" : `Working (${runs.length})`, this.root);
    for (const r of runs) {
      const card = el("div", "run-card", "", this.root);
      el("div", "run-goal", r.goal, card);
      el("div", "run-meta", `${r.agents.join(" → ")} · ${r.projectId}`, card);
      el("div", "run-meta run-clock", `${r.steps} steps · ${elapsed(this.now() - Date.parse(r.startedAt))} · $${r.usd.toFixed(2)}`, card);
      if (r.lastTool) el("div", "run-tool", `now: ${r.lastTool}`, card);
      if (r.lastText) el("div", "run-text", r.lastText.length > 160 ? `${r.lastText.slice(0, 160)}…` : r.lastText, card);
      const stop = el("button", "ac-button deny run-stop", "Stop", card);
      stop.type = "button";
      stop.addEventListener("click", () => {
        if (this.send({ type: "run.stop", projectId: r.projectId })) stop.disabled = true;
      });
    }
  }

  /** Updates the elapsed times without rebuilding the cards. */
  tick(): void {
    const clocks = this.root.querySelectorAll(".run-clock");
    this.runs.forEach((r, i) => {
      const c = clocks[i];
      if (c) c.textContent = `${r.steps} steps · ${elapsed(this.now() - Date.parse(r.startedAt))} · $${r.usd.toFixed(2)}`;
    });
  }
}
