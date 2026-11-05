import { el } from "./dom.js";

const FLASH_MS = 1500;
/** How long Go online waits for the city before it gives the button back. */
export const START_WAIT_MS = 20_000;
/** The link that starts the city, once `agentcity link install` registered it. */
export const START_LINK = "agentcity://start";

/**
 * Top bar in two boxes: the city status with Go online at top left, and the controls (Inbox, Stop all, Roofs, HQ)
 * at top right. Each box is as wide as its content; the top centre stays free for the HQ bar.
 * Chat and Terminal live in the dock, so they have no button here.
 */
export class Hud {
  readonly root: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly status: HTMLElement;
  private readonly inbox: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private anyPaused = false;
  private stopAll: (paused: boolean) => void = () => undefined;
  private readonly controls: HTMLElement;
  private readonly clicks: Record<"inbox" | "hq", () => void> = { inbox: () => undefined, hq: () => undefined };
  private readonly go?: HTMLButtonElement;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  /** `start` opens the start link; without it (the demo) there is no Go online button. */
  constructor(parent: HTMLElement, onRoofs: () => void, start?: () => void) {
    this.root = el("div", "hud", "", parent);
    const city = el("div", "ac-box hud-box hud-city", "", this.root);
    this.controls = el("div", "ac-box hud-box hud-controls", "", this.root);
    this.dot = el("span", "st-dot block", "", city);
    this.status = el("span", "hud-status", "offline", city);
    if (start) {
      const go = el("button", "ac-button hud-go", "Go online", city);
      go.type = "button";
      go.title = "Starts the city on this computer. Needs agentcity link install, run once in a terminal.";
      go.addEventListener("click", () => {
        go.textContent = "starting…";
        go.disabled = true;
        go.blur();
        start();
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = setTimeout(() => {
          this.resetGo();
          this.status.textContent = "offline: run agentcity link install once";
        }, START_WAIT_MS);
      });
      this.go = go;
    }
    this.inbox = this.barButton("hud-inbox", "Inbox", () => this.clicks.inbox());
    this.stop = this.barButton("hud-stop", "Stop all", () => this.stopAll(!this.anyPaused));
    this.barButton("hud-roofs", "Roofs (R)", onRoofs);
    this.barButton("hud-hq", "HQ (H)", () => this.clicks.hq());
  }

  private barButton(cls: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", `ac-button ${cls}`, label, this.controls);
    b.type = "button";
    b.addEventListener("click", () => {
      onClick();
      b.blur();
    });
    return b;
  }

  setOnline(online: boolean): void {
    this.status.textContent = online ? "online" : "offline";
    this.status.classList.toggle("online", online);
    this.dot.className = `st-dot ${online ? "done" : "block"}`;
    if (online || this.go?.disabled !== true) this.resetGo();
    if (this.go) this.go.hidden = online;
  }

  private resetGo(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (!this.go) return;
    this.go.textContent = "Go online";
    this.go.disabled = false;
  }

  /** Whether any project is paused. Stop all then reads Resume all. */
  setPaused(anyPaused: boolean): void {
    this.anyPaused = anyPaused;
    this.stop.textContent = anyPaused ? "Resume all" : "Stop all";
  }

  /** Runs when Stop all or Resume all is clicked, with the paused state to set. */
  onStopAll(cb: (paused: boolean) => void): void {
    this.stopAll = cb;
  }

  /** Count of requests that wait on the player. Above 0 the button reads "Inbox N" in amber; at 0 it reads "Inbox" in the plain style. */
  setInbox(n: number): void {
    this.inbox.textContent = n > 0 ? `Inbox ${n}` : "Inbox";
    this.inbox.classList.toggle("has-pending", n > 0);
  }

  /** Runs when the Inbox button is clicked. */
  onInbox(cb: () => void): void {
    this.clicks.inbox = cb;
  }

  /** Runs when the HQ button is clicked. */
  onHq(cb: () => void): void {
    this.clicks.hq = cb;
  }

  /** Highlights the status when a send was dropped because the server is not connected. */
  flashOffline(): void {
    this.status.classList.add("flash");
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.status.classList.remove("flash"), FLASH_MS);
  }
}
