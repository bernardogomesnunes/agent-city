import type { DecisionView, DiffFileView } from "@agentcity/world/shared";
import { button, diffLines, rollbackControls } from "./task-thread.js";
import { el } from "./dom.js";
import type { Send } from "./hq-panel.js";

/** What the Inbox needs beyond sending messages. All parts are optional. */
export interface InboxHooks {
  /** The display name of an agent id. */
  names?: (id: string) => string;
  /** The checkpoint of a task, from the board views the client holds. Null hides Roll back. */
  checkpoint?: (taskId: string) => string | null;
  /** Whether the city can answer this approval. False means only the terminal can; the card then has no buttons. */
  approvalLocal?: (approvalId: number) => boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The Inbox popup: every request that waits on the player as a card, oldest first, answered in place.
 * Sends the messages the board and dock already use.
 */
export class Inbox {
  readonly root: HTMLElement;
  private open_ = false;
  private list: DecisionView[] = [];
  private listKey = "";
  private readonly sending = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly errors = new Map<string, string>();
  private readonly drafts = new Map<string, string>();
  private readonly later = new Set<string>();
  private readonly diffs = new Map<string, DiffFileView[]>();
  private readonly asked = new Set<string>();
  private readonly names: (id: string) => string;
  private readonly checkpoint: (taskId: string) => string | null;
  private readonly approvalLocal: (approvalId: number) => boolean;
  private readonly onOpenChange: (open: boolean) => void;

  constructor(parent: HTMLElement, private readonly send: Send, hooks: InboxHooks = {}) {
    this.names = hooks.names ?? ((id) => id);
    this.checkpoint = hooks.checkpoint ?? (() => null);
    this.approvalLocal = hooks.approvalLocal ?? (() => true);
    this.onOpenChange = hooks.onOpenChange ?? (() => undefined);
    this.root = el("div", "ac-box inbox", "", parent);
    this.root.hidden = true;
    this.draw();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** How many requests wait, skipped ones included. */
  get count(): number {
    return this.list.length;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    // Cards put off with Skip or Later come back each time the popup opens.
    this.later.clear();
    this.root.hidden = false;
    this.draw();
    this.onOpenChange(true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.hidden = true;
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.onOpenChange(false);
  }

  /** A new list from the server. The same list again changes nothing, so typing keeps its focus. */
  render(list: DecisionView[]): void {
    const key = JSON.stringify(list);
    if (key === this.listKey) return;
    this.listKey = key;
    // A merge that left the list and comes back has new work: its diff is asked for again.
    const live = new Set(list.map((d) => d.taskId).filter((id) => id !== undefined));
    for (const id of [...this.asked]) {
      if (live.has(id)) continue;
      this.asked.delete(id);
      this.diffs.delete(id);
    }
    const ids = new Set(list.map((d) => d.id));
    // State follows its card: only ids that left the list lose their drafts, errors and in-flight marks.
    for (const m of [this.drafts, this.errors]) for (const id of [...m.keys()]) if (!ids.has(id)) m.delete(id);
    for (const id of [...this.sending]) if (!ids.has(id)) this.settle(id);
    for (const id of [...this.timers.keys()]) if (!ids.has(id)) this.settle(id);
    for (const id of [...this.later]) if (!ids.has(id)) this.later.delete(id);
    this.list = [...list].sort((a, b) => a.since.localeCompare(b.since));
    this.draw();
  }

  setDiff(taskId: string, files: DiffFileView[]): void {
    this.diffs.set(taskId, files);
    this.draw();
  }

  /** The result of a review or plan answer. A failure re-enables the card and shows the reason. */
  setResult(key: string, ok: boolean, error?: string): void {
    const d = this.list.find((x) => (x.taskId ?? x.goalId) === key);
    if (!d) return;
    this.settle(d.id);
    if (ok) this.errors.delete(d.id);
    else this.errors.set(d.id, error ?? "failed");
    this.draw();
  }

  /** A server `error` reply. It ends every pending send, so the player can fix the answer and try again. */
  setError(message: string): void {
    if (this.sending.size === 0) return;
    for (const id of [...this.sending]) {
      this.errors.set(id, message);
      this.settle(id);
    }
    this.draw();
  }

  private act(d: DecisionView, m: Parameters<Send>[0]): void {
    if (this.sending.has(d.id)) return;
    if (this.send(m)) {
      this.sending.add(d.id);
      this.errors.delete(d.id);
      // A send the server ignores gets no reply. After 10 s the card is usable again.
      this.timers.set(d.id, setTimeout(() => {
        this.timers.delete(d.id);
        if (!this.sending.has(d.id) || !this.list.some((x) => x.id === d.id)) return;
        this.sending.delete(d.id);
        this.errors.set(d.id, "no answer from the city, try again");
        this.draw();
      }, 10000));
      this.draw();
    }
  }

  /** The send of a card ended: it is no longer in flight and its timer stops. */
  private settle(id: string): void {
    this.sending.delete(id);
    const t = this.timers.get(id);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(id);
  }

  private putOff(d: DecisionView): void {
    this.later.add(d.id);
    this.draw();
  }

  private draw(): void {
    // A redraw while the player types keeps the focus and cursor, so the next letters do not reach the game keys.
    const old = this.root.querySelector<HTMLTextAreaElement>("textarea:focus");
    const typing = old ? { id: old.dataset.id, from: old.selectionStart, to: old.selectionEnd } : null;
    this.root.replaceChildren();
    const head = el("div", "inbox-head", "", this.root);
    el("span", "ac-title", "Inbox", head);
    el("span", "inbox-count", `${this.list.length} waiting`, head);
    const close = el("button", "panel-fold", "×", head);
    close.type = "button";
    close.title = "Close (Esc)";
    close.setAttribute("aria-label", "Close Inbox");
    close.addEventListener("click", () => this.close());
    if (this.list.length === 0) {
      el("div", "ac-empty", "Nothing waits on you", this.root);
      return;
    }
    const shown = this.list.filter((d) => !this.later.has(d.id));
    if (shown.length === 0) el("div", "ac-empty", "Everything is put off. Reopen the Inbox to see it again.", this.root);
    for (const d of shown) this.card(d, typing);
  }

  private card(d: DecisionView, typing: { id: string | undefined; from: number | null; to: number | null } | null): void {
    const sending = this.sending.has(d.id);
    const card = el("div", `inbox-card${d.kind === "blocked" ? " ask block" : ""}`, "", this.root);
    card.dataset.id = d.id;
    const kind = d.kind === "approval" ? "tool approval" : d.kind;
    el("div", "inbox-meta", `${d.projectId} · ${this.names(d.agentId)} · ${kind}${sending ? " · sending…" : ""}`, card);
    el("div", "inbox-title", d.title, card);
    if (d.text) el("div", d.kind === "approval" ? "inbox-text ac-mono" : "inbox-text", d.text, card);

    if (d.kind === "merge" && d.taskId) this.diff(card, d.taskId);

    let box: HTMLTextAreaElement | null = null;
    if (d.kind !== "approval") {
      box = el("textarea", "inbox-box", "", card);
      box.dataset.id = d.id;
      box.value = this.drafts.get(d.id) ?? "";
      // The server takes at most 4000 characters in task.answer and review.answer.
      box.maxLength = 4000;
      box.placeholder = d.kind === "blocked" ? "Your answer" : d.kind === "plan" ? "What should change?" : "Notes for the agent (optional)";
      const field = box;
      field.addEventListener("input", () => this.drafts.set(d.id, field.value));
      if (typing && typing.id === d.id) {
        field.focus();
        field.setSelectionRange(typing.from ?? field.value.length, typing.to ?? field.value.length);
      }
    }
    const text = (): string => (box?.value ?? "").trim();

    const row = el("div", "inbox-buttons", "", card);
    const b = (label: string, onClick: () => void, cls = ""): void => {
      // Skip and Later never talk to the server, so they stay usable while an answer is out.
      button(row, label, onClick, cls ? `ac-button ${cls}` : undefined).disabled = sending && label !== "Skip" && label !== "Later";
    };
    if (d.kind === "approval" && d.approvalId !== undefined && !this.approvalLocal(d.approvalId)) {
      row.remove();
      el("div", "inbox-text", "answer in your terminal", card);
    } else if (d.kind === "approval" && d.approvalId !== undefined) {
      const id = d.approvalId;
      b("Allow", () => this.act(d, { type: "approve", id, decision: "approved" }), "approve");
      b("Deny", () => this.act(d, { type: "approve", id, decision: "denied" }), "deny");
    } else if (d.kind === "blocked" && d.taskId) {
      const taskId = d.taskId;
      b("Answer", () => {
        if (text()) this.act(d, { type: "task.answer", taskId, text: text() });
      }, "approve");
      b("Retry", () => this.act(d, { type: "task.action", taskId, action: "retry" }), "approve");
      b("Cancel", () => this.act(d, { type: "task.action", taskId, action: "cancel" }), "deny");
      b("Skip", () => this.putOff(d));
      // Roll back needs a checkpoint. The server answers "no checkpoint yet" otherwise, so the button stays hidden.
      if (this.checkpoint(taskId) !== null) {
        rollbackControls(row, card, "inbox-confirm", () => this.act(d, { type: "task.action", taskId, action: "rollback" }), sending);
      }
    } else if (d.kind === "merge" && d.taskId) {
      const taskId = d.taskId;
      const review = (option: "merge" | "changes" | "reject") => () => {
        const t = text();
        if (option === "changes" && !t) return;
        this.act(d, { type: "review.answer", taskId, option, ...(t ? { text: t } : {}) });
      };
      b("Merge", review("merge"), "approve");
      b("Send back", review("changes"));
      b("Reject", review("reject"), "deny");
      b("Later", () => this.putOff(d));
    } else if (d.kind === "plan" && d.goalId) {
      const goalId = d.goalId;
      b("Approve", () => this.act(d, { type: "plan.answer", goalId, option: "approve" }), "approve");
      b("Send back", () => {
        if (text()) this.act(d, { type: "plan.answer", goalId, option: "changes", text: text() });
      });
      b("Reject", () => {
        const t = text();
        this.act(d, { type: "plan.answer", goalId, option: "reject", ...(t ? { text: t } : {}) });
      }, "deny");
      b("Later", () => this.putOff(d));
    } else {
      b("Later", () => this.putOff(d));
    }
    const error = this.errors.get(d.id);
    if (error) el("div", "inbox-error", error, card);
  }

  private diff(card: HTMLElement, taskId: string): void {
    if (!this.asked.has(taskId) && this.send({ type: "diff.request", taskId })) this.asked.add(taskId);
    const diff = el("div", "inbox-diff", "", card);
    const files = this.diffs.get(taskId);
    if (!files) el("div", "ac-empty", "loading diff…", diff);
    else if (files.length === 0) el("div", "ac-empty", "no file changes", diff);
    else {
      for (const f of files) {
        el("div", "hq-row-sub", `${f.path} · ${f.status}${f.truncated ? " · cut" : ""}`, diff);
        diffLines(diff, f);
      }
    }
  }
}
