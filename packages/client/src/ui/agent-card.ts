import type { AgentView, ModelGroup } from "@agentcity/world/shared";
import { el } from "./dom.js";
import type { Send } from "./hq-panel.js";

const OTHER = "__other__";

/**
 * Card for one clicked agent: name, role, activity, last text, project, and a model picker.
 * Closes on Esc or a click elsewhere. Saving a model makes a new agent version on the server.
 */
export class AgentCard {
  readonly root: HTMLElement;
  private readonly info: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly other: HTMLInputElement;
  private readonly status: HTMLElement;
  private id: string | null = null;
  private open_ = false;
  private groups: ModelGroup[] = [];
  /** The user's unsaved choice. null while untouched, so the select follows the agent's model. */
  private pick: string | null = null;
  private drawnKey = "";

  constructor(
    parent: HTMLElement,
    private readonly send: Send,
    private readonly find: (id: string) => AgentView | undefined,
    private readonly onOpenChange: (open: boolean) => void = () => undefined,
    /** Opens the newest chat with this agent, or starts one. */
    onMessage?: (agentId: string) => void,
    /** Starts a new chat with this agent. */
    onNewChat?: (agentId: string) => void,
  ) {
    this.root = el("div", "ac-box agent-card", "", parent);
    this.root.hidden = true;
    this.info = el("div", "card-info", "", this.root);
    if (onMessage) {
      const talk = el("button", "ac-button approve card-message", "Message", this.root);
      talk.type = "button";
      talk.addEventListener("click", () => {
        if (this.id) onMessage(this.id);
        this.close();
      });
    }
    if (onNewChat) {
      const fresh = el("button", "ac-button card-new-chat", "New chat", this.root);
      fresh.type = "button";
      fresh.addEventListener("click", () => {
        if (this.id) onNewChat(this.id);
        this.close();
      });
    }
    const box = el("div", "card-model", "", this.root);
    el("span", "ac-label", "model", box);
    this.select = el("select", "model-select", "", box);
    this.select.addEventListener("change", () => {
      this.pick = this.select.value;
      this.other.hidden = this.pick !== OTHER;
      if (!this.other.hidden) this.other.focus();
    });
    this.other = el("input", "model-other", "", box);
    this.other.placeholder = "model id, e.g. api/groq/llama-3.3-70b";
    this.other.spellcheck = false;
    this.other.hidden = true;
    const save = el("button", "ac-button model-save", "Save", box);
    save.type = "button";
    save.addEventListener("click", () => this.save());
    this.status = el("div", "model-status", "", box);
    // Capture phase: runs before the canvas handler that opens the card for the sprite under the cursor.
    for (const type of ["mousedown", "touchstart"]) {
      document.addEventListener(type, (e) => {
        if (this.open_ && !this.root.contains(e.target as Node)) this.close();
      }, true);
    }
  }

  get isOpen(): boolean {
    return this.open_;
  }

  show(id: string): void {
    const fresh = !this.open_ || this.id !== id;
    if (fresh) this.reset();
    this.id = id;
    this.refresh();
    if (!this.id) return;
    if (fresh) this.send({ type: "models.list" });
    if (this.open_) return;
    this.open_ = true;
    this.root.hidden = false;
    this.onOpenChange(true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.id = null;
    this.reset();
    this.root.hidden = true;
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.onOpenChange(false);
  }

  /** The server's model list arrived. */
  setModels(groups: ModelGroup[]): void {
    this.groups = groups;
    this.refresh();
  }

  /** The server saved a model for `agentId` as `version`. */
  saved(agentId: string, version: number): void {
    if (agentId !== this.id) return;
    this.pick = null;
    this.other.hidden = true;
    this.other.value = "";
    this.status.textContent = `saved v${version}`;
    this.refresh();
  }

  /** Redraws from the current state. Closes when the agent is gone. */
  refresh(): void {
    if (!this.id) return;
    const a = this.find(this.id);
    if (!a) return this.close();
    this.info.replaceChildren();
    el("div", "ac-title", a.name, this.info);
    for (const [k, v] of [
      ["role", a.role],
      ["activity", a.activity.replace("_", " ")],
      ["last", a.lastText ?? "-"],
      ["project", a.projectId ?? "-"],
    ]) {
      const row = el("div", "card-row", "", this.info);
      el("span", "ac-label", k, row);
      el("span", "card-value", v, row);
    }
    this.drawSelect(a.model ?? "");
  }

  private reset(): void {
    this.pick = null;
    this.drawnKey = "";
    this.other.hidden = true;
    this.other.value = "";
    this.status.textContent = "";
  }

  /** Rebuilds the options only when they change, so an open dropdown is not reset by a state update. */
  private drawSelect(current: string): void {
    const chosen = this.pick ?? current;
    const key = JSON.stringify([this.groups, current, chosen]);
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.select.replaceChildren();
    const listed = this.groups.some((g) => g.models.includes(current));
    if (current && !listed) el("option", "", current, this.select).value = current;
    for (const g of this.groups) {
      const og = el("optgroup", "", "", this.select);
      og.label = g.label;
      if (g.error) {
        const o = el("option", "", g.error, og);
        o.disabled = true;
        o.value = "";
      }
      for (const m of g.models) el("option", "", m, og).value = m;
    }
    el("option", "", "other...", this.select).value = OTHER;
    this.select.value = chosen;
  }

  private save(): void {
    if (!this.id) return;
    const model = this.select.value === OTHER ? this.other.value.trim() : this.select.value;
    if (!model) return;
    this.status.textContent = "";
    this.send({ type: "agent.model", agentId: this.id, model });
  }
}
