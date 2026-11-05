import type { DecisionView } from "@agentcity/world/shared";

export interface AlertDeps {
  bellOn: () => boolean;
  hidden: () => boolean;
  notify: (body: string) => void;
  tone: () => void;
  names: (id: string) => string;
}

const BELL_KEY = "agentcity.bell";

/** The bell is on unless the stored value is "off". A storage that throws counts as on. */
export function bellOn(): boolean {
  try {
    return localStorage.getItem(BELL_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Saves the bell state. A storage that throws keeps nothing: the toggle works until the page reloads. */
export function setBell(on: boolean): void {
  try {
    localStorage.setItem(BELL_KEY, on ? "on" : "off");
  } catch {
    // Blocked storage: the setting lasts until reload.
  }
}

/** A short message that fades after `ms`. Command errors and results land here. */
export function toast(text: string, ms = 6000): void {
  const layer = document.querySelector(".ui-layer") ?? document.body;
  let stack = layer.querySelector<HTMLElement>(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    layer.append(stack);
  }
  const box = document.createElement("div");
  box.className = "ac-box toast";
  box.setAttribute("role", "status");
  box.textContent = text;
  stack.append(box);
  setTimeout(() => box.remove(), ms);
}

/** Desktop notification for a new decision. Shows nothing when permission is not granted or the API is missing. */
export function browserNotify(body: string): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification("Agent City", { body });
  } catch {
    // The notification API failed: the page stays silent.
  }
}

/** One 880 Hz sine for 0.15 s through the Web Audio API. Silent when the API is missing or blocked. */
export function playTone(): void {
  try {
    const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => void ctx.close().catch(() => undefined);
  } catch {
    // The audio API failed: the bell stays silent.
  }
}

/**
 * Tells the player about new decisions. A tone when the bell is on. A desktop notification when the page is hidden.
 * An id counts as seen once it appears in any list, so it never alerts again.
 */
export class Alerts {
  private readonly seen = new Set<string>();
  private first = true;
  private readonly deps: AlertDeps;

  constructor(deps: AlertDeps) {
    this.deps = deps;
  }

  /** Alerts once for the ids this client has not seen. The first list only records its ids. */
  update(list: DecisionView[]): void {
    const fresh = list.filter((d) => !this.seen.has(d.id));
    for (const d of list) this.seen.add(d.id);
    const wasFirst = this.first;
    this.first = false;
    if (wasFirst || fresh.length === 0) return;
    if (this.deps.bellOn()) this.deps.tone();
    if (this.deps.hidden()) {
      // One notification per update, naming the first new decision.
      const d = fresh[0];
      this.deps.notify(`${this.deps.names(d.agentId)}: ${d.title}`);
    }
  }

  /** Asks for notification permission while it is undecided. Runs on the first J press or HUD click. */
  askPermission(): void {
    try {
      if (typeof Notification === "undefined" || Notification.permission !== "default") return;
      void Promise.resolve(Notification.requestPermission()).catch(() => undefined);
    } catch {
      // No notification API: nothing to ask.
    }
  }
}
