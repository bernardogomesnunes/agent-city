import type { HqStats } from "@agentcity/world/shared";
import { el } from "./dom.js";

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const pct = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);
const clock = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function empty(box: HTMLElement, text: string): void {
  el("div", "ac-empty", text, box);
}

/** The latest actions, newest first: time, agent, what it did. */
export function renderActivity(box: HTMLElement, stats: HqStats | null): void {
  box.replaceChildren();
  if (!stats) return empty(box, "loading…");
  if (stats.activity.length === 0) return empty(box, "Nothing yet. Start a run.");
  for (const a of stats.activity) {
    const row = el("div", `hw-act ${a.kind}`, "", box);
    el("span", "hw-time", clock(a.ts), row);
    el("span", "hw-who", a.agentId, row);
    el("span", "hw-what", a.text, row);
    row.title = `${a.projectId} · ${a.ts}`;
  }
}

/** One row per agent: runs, share finished with "done", tool calls and spend over 7 days. */
export function renderPerformance(box: HTMLElement, stats: HqStats | null, names: Map<string, string>): void {
  box.replaceChildren();
  if (!stats) return empty(box, "loading…");
  if (stats.perAgent.length === 0) return empty(box, "No runs in the last 7 days.");
  const table = el("table", "hw-table", "", box);
  const head = el("tr", "", "", el("thead", "", "", table));
  for (const h of ["agent", "runs", "done", "tools", "spend"]) el("th", "", h, head);
  const body = el("tbody", "", "", table);
  for (const a of stats.perAgent) {
    const tr = el("tr", "", "", body);
    el("td", "", names.get(a.agentId) ?? a.agentId, tr);
    el("td", "", String(a.runs), tr);
    el("td", "", pct(a.done, a.runs), tr);
    el("td", "", String(a.tools), tr);
    el("td", "", usd(a.usd), tr);
  }
}

/** City totals for 7 days as four tiles, and runs per day as bars. */
export function renderAnalytics(box: HTMLElement, stats: HqStats | null): void {
  box.replaceChildren();
  if (!stats) return empty(box, "loading…");
  const tiles = el("div", "hw-tiles", "", box);
  const answered = stats.approvals.approved + stats.approvals.denied;
  for (const [label, value] of [
    ["runs", String(stats.runs)],
    ["finished", pct(stats.done, stats.runs)],
    ["spend", usd(stats.usd)],
    ["approved", pct(stats.approvals.approved, answered)],
  ] as const) {
    const t = el("div", "hw-tile", "", tiles);
    el("span", "hw-tile-label", label, t);
    el("span", "hw-tile-value", value, t);
  }
  const most = Math.max(1, ...stats.days.map((d) => d.runs));
  const chart = el("div", "hw-bars", "", box);
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", `Runs per day: ${stats.days.map((d) => `${d.day} ${d.runs}`).join(", ")}`);
  for (const d of stats.days) {
    const col = el("div", "hw-bar-col", "", chart);
    col.title = `${d.day}: ${d.runs} runs, ${usd(d.usd)}`;
    const bar = el("div", "hw-bar", "", col);
    bar.style.height = `${Math.round((d.runs / most) * 100)}%`;
    el("span", "hw-bar-label", new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "narrow" }), col);
  }
  el("div", "hw-sub", `${stats.tools} tool calls · ${stats.approvals.pending} approvals waiting`, box);
}
