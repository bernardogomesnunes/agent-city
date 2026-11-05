import type { ApprovalView, CityState, SessionMessageView, SessionView } from "@agentcity/world/shared";
import { el } from "./dom.js";
import { markdown } from "./markdown.js";
import { loadFolded, saveFolded } from "./fold.js";
import type { Send } from "./hq-panel.js";

export const MESSAGE_MAX = 4000;
export type DockTab = "chat" | "terminal";
/** Stored in the fold list while the dock is open: the dock starts folded. */
const OPEN_KEY = "dock-open";

const STATUS_TEXT: Record<SessionView["status"], string> = { idle: "idle", working: "working", queued: "working", waiting: "waiting for project" };

export interface DockDeps {
  send: Send;
  /** Project ids, from the HQ config. */
  projects(): Array<{ id: string; agents: string[] }>;
  onOpenChange?(open: boolean): void;
  /** The terminal tab opened or closed by the player (tab switch or fold). */
  onTerminal?(shown: boolean): void;
}

/**
 * The bottom dock: a bar that is always there, unfolding to the chat (chat list and one thread) or the terminal.
 * A chat is one conversation with an agent, with or without a project. The server gives each chat an id; the list
 * and the thread key on it. Messages sent while the agent works wait as queued.
 */
export class Dock {
  readonly root: HTMLElement;
  /** Where the terminal mounts. */
  readonly terminalPane: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly tabs = new Map<DockTab, HTMLButtonElement>();
  private readonly chat: HTMLElement;
  private readonly list: HTMLElement;
  private readonly thread: HTMLElement;
  private sessions: SessionView[] = [];
  private readonly threads = new Map<number, Map<number, SessionMessageView>>();
  private state: CityState | null = null;
  /** The open thread. `id` is null from New chat until the server answers with the new chat's id. */
  private current: { id: number | null; agentId: string; projectId?: string } | null = null;
  private listView: "list" | "new" = "list";
  private newAgent = "";
  private tab_: DockTab = "chat";
  private open_ = false;
  private draft = "";

  constructor(parent: HTMLElement, private readonly d: DockDeps) {
    this.root = el("div", "ac-box dock", "", parent);
    const bar = el("div", "dock-bar", "", this.root);
    for (const [t, label] of [["chat", "Chat (C)"], ["terminal", "Terminal (T)"]] as const) {
      const b = el("button", "dock-tab", label, bar);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.open_ && this.tab_ === t) this.fold();
        else this.open(t);
      });
      this.tabs.set(t, b);
    }
    this.summary = el("span", "dock-summary", "no sessions yet", bar);
    const fold = el("button", "panel-fold dock-fold", "▴", bar);
    fold.type = "button";
    fold.setAttribute("aria-label", "Open or fold the dock");
    bar.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".dock-tab")) return;
      if (this.open_) this.fold();
      else this.open(this.tab_);
    });
    const body = el("div", "dock-body", "", this.root);
    this.chat = el("div", "dock-chat", "", body);
    this.list = el("div", "dock-list", "", this.chat);
    this.thread = el("div", "dock-thread", "", this.chat);
    this.terminalPane = el("div", "dock-term", "", body);
    this.render(null);
    this.applyTab();
    // Opened quietly: the owner reads isOpen after construction.
    if (loadFolded(OPEN_KEY)) {
      this.open_ = true;
      this.root.classList.remove("folded");
    } else this.fold(true);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  get tab(): DockTab {
    return this.tab_;
  }

  /** The id of the chat shown, or null when none is shown or the server has not answered New chat yet. */
  get openChatId(): number | null {
    return this.current?.id ?? null;
  }

  open(tab: DockTab = this.tab_): void {
    const wasTerminal = this.open_ && this.tab_ === "terminal";
    this.tab_ = tab;
    this.applyTab();
    if (!this.open_) {
      this.open_ = true;
      this.root.classList.remove("folded");
      saveFolded(OPEN_KEY, true);
      this.d.onOpenChange?.(true);
    }
    if (tab === "terminal" && !wasTerminal) this.d.onTerminal?.(true);
    if (tab === "chat" && wasTerminal) this.d.onTerminal?.(false);
    if (tab === "chat") this.focusInput();
  }

  /** Folds to the bar. `quiet`: no open-change event (the first draw). */
  fold(quiet = false): void {
    const wasTerminal = this.open_ && this.tab_ === "terminal";
    const was = this.open_;
    this.open_ = false;
    this.root.classList.add("folded");
    if (quiet) return;
    saveFolded(OPEN_KEY, false);
    if (wasTerminal) this.d.onTerminal?.(false);
    if (was) this.d.onOpenChange?.(false);
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  /** The close the overlay stack calls on Esc. */
  close(): void {
    this.fold();
  }

  /** Opens one chat from the list. */
  openSession(sessionId: number): void {
    const s = this.sessions.find((x) => x.id === sessionId);
    this.current = { id: sessionId, agentId: s?.agentId ?? "", projectId: s?.projectId || undefined };
    this.listView = "list";
    this.d.send({ type: "session.open", sessionId });
    this.open("chat");
    this.renderList();
    this.renderThread();
  }

  /** Starts a new chat with this agent, on this project or on none. The thread opens when the server answers. */
  openNew(agentId: string, projectId?: string): void {
    this.start(agentId, projectId, {});
  }

  /** Starts a chat about a task or a goal with this agent. The thread opens when the server answers. */
  openRef(ref: { agentId: string; projectId: string; taskId?: string; goalId?: string }): void {
    this.start(ref.agentId, ref.projectId, {
      ...(ref.taskId ? { taskId: ref.taskId } : {}),
      ...(ref.goalId ? { goalId: ref.goalId } : {}),
    });
  }

  private start(agentId: string, projectId: string | undefined, about: { taskId?: string; goalId?: string }): void {
    this.current = { id: null, agentId, projectId };
    this.listView = "list";
    this.d.send({ type: "session.new", agentId, ...(projectId ? { projectId } : {}), ...about });
    this.open("chat");
    this.renderList();
    this.renderThread();
  }

  /** Opens the newest chat with this agent, or starts one when it has none. The card's Message button. */
  openAgent(agentId: string, projectId?: string): void {
    const newest = this.sessions
      .filter((s) => s.agentId === agentId)
      .sort((a, b) => b.lastTs.localeCompare(a.lastTs))[0];
    if (newest) this.openSession(newest.id);
    else this.openNew(agentId, projectId);
  }

  /** The New chat form with this agent picked. */
  newChat(agentId = ""): void {
    this.newAgent = agentId;
    this.listView = "new";
    this.open("chat");
    this.renderList();
  }

  /** City state: names and approvals. The thread redraws only when what it shows changed, so typing is not disturbed. */
  render(state: CityState | null): void {
    this.state = state;
    const key = JSON.stringify([
      (state?.approvals ?? []).filter((a) => a.projectId === this.current?.projectId).map((a) => a.id),
      (state?.agents ?? []).map((a) => a.name),
    ]);
    this.renderSummary();
    if (this.listView === "list") this.renderList();
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.renderThread();
  }

  private drawnKey = "";

  setSessions(list: SessionView[]): void {
    this.sessions = list;
    this.renderSummary();
    this.renderList();
    this.renderHead();
  }

  /** The messages of one chat. The first answer to New chat becomes the open chat's id. */
  setThread(sessionId: number, messages: SessionMessageView[]): void {
    this.threads.set(sessionId, new Map(messages.map((m) => [m.id, m])));
    if (this.current && this.current.id === null) this.current.id = sessionId;
    this.renderThread();
  }

  onMessage(m: SessionMessageView): void {
    const t = this.threads.get(m.sessionId);
    // Threads not opened yet load in full when opened.
    if (!t) return;
    t.set(m.id, m);
    if (this.current?.id === m.sessionId) this.renderThread();
  }

  private applyTab(): void {
    for (const [t, b] of this.tabs) b.classList.toggle("active", t === this.tab_);
    this.chat.hidden = this.tab_ !== "chat";
    this.terminalPane.hidden = this.tab_ !== "terminal";
  }

  private name(agentId: string): string {
    return this.state?.agents.find((a) => a.id === agentId)?.name ?? agentId;
  }

  private currentSession(): SessionView | undefined {
    return this.sessions.find((s) => s.id === this.current?.id);
  }

  private renderSummary(): void {
    const latest = [...this.sessions].sort((a, b) => b.lastTs.localeCompare(a.lastTs))[0];
    const busy = this.sessions.filter((s) => s.status !== "idle").length;
    this.summary.textContent = latest
      ? `${this.sessions.length} chat(s)${busy ? `, ${busy} busy` : ""} · ${this.name(latest.agentId)} · ${latest.projectId || "no project"}: ${latest.status === "idle" ? latest.last : STATUS_TEXT[latest.status]}`
      : "no chats yet";
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (this.listView === "new") return this.renderNew();
    const bar = el("div", "hq-pane-bar", "", this.list);
    el("span", "hq-row-sub", `${this.sessions.length} chat(s)`, bar);
    const add = el("button", "ac-button approve", "+ New chat", bar);
    add.type = "button";
    add.addEventListener("click", () => this.newChat());
    if (this.sessions.length === 0) el("div", "ac-empty", "No chats yet. Start one with New chat.", this.list);
    const sorted = [...this.sessions].sort((a, b) => b.lastTs.localeCompare(a.lastTs));
    for (const s of sorted) {
      const row = el("button", "dock-session", "", this.list);
      row.type = "button";
      row.classList.toggle("active", this.current?.id === s.id);
      const head = el("span", "dock-session-head", "", row);
      el("span", "dock-session-name", s.title || "New chat", head);
      if (s.status !== "idle") el("span", `hw-tag ${s.status === "waiting" ? "warn" : "live"}`, s.queued > 0 && s.status !== "waiting" ? `working +${s.queued}` : STATUS_TEXT[s.status], head);
      el("span", "hq-row-sub", `${this.name(s.agentId)} · ${s.projectId || "no project"}`, row);
      el("span", "dock-session-last", s.last || "no messages", row);
      row.addEventListener("click", () => this.openSession(s.id));
    }
  }

  private renderNew(): void {
    const top = el("div", "hq-pane-bar", "", this.list);
    const back = el("button", "ac-button hq-back", "‹ Back", top);
    back.type = "button";
    back.addEventListener("click", () => this.showList());
    el("span", "ac-title", "New chat", top);
    const projects = this.d.projects();
    const field = <K extends "select">(label: string, tag: K) => {
      const wrap = el("label", "ac-field", "", this.list);
      el("span", "ac-label", label, wrap);
      return el(tag, "", "", wrap);
    };
    const project = field("Project", "select");
    project.className = "new-project";
    el("option", "", "No project", project).value = "";
    for (const p of projects) el("option", "", p.id, project).value = p.id;
    const agent = field("Agent", "select");
    agent.className = "new-agent";
    const fill = () => {
      const granted = projects.find((p) => p.id === project.value)?.agents ?? [];
      // With no project, every agent shows.
      const all = this.state?.agents ?? [];
      // Agents on the project first; the rest still show, so a new agent can be tried.
      const ordered = [...all.filter((a) => granted.includes(a.id)), ...all.filter((a) => !granted.includes(a.id))];
      const chosen = agent.value || this.newAgent;
      agent.replaceChildren();
      for (const a of ordered) el("option", "", `${a.name} (${a.role})${granted.includes(a.id) ? "" : " · not on project"}`, agent).value = a.id;
      if (ordered.some((a) => a.id === chosen)) agent.value = chosen;
    };
    project.addEventListener("change", fill);
    fill();
    const buttons = el("div", "hq-row-buttons", "", this.list);
    const go = el("button", "ac-button approve", "Start", buttons);
    go.type = "button";
    go.addEventListener("click", () => {
      if (agent.value) this.openNew(agent.value, project.value || undefined);
    });
    const cancel = el("button", "ac-button", "Cancel", buttons);
    cancel.type = "button";
    cancel.addEventListener("click", () => this.showList());
  }

  private showList(): void {
    this.listView = "list";
    this.renderList();
  }

  private renderHead(): void {
    const head = this.thread.querySelector<HTMLElement>(".dock-thread-head");
    if (!head || !this.current) return;
    const s = this.currentSession();
    const status = head.querySelector<HTMLElement>(".dock-thread-status")!;
    status.textContent = s ? (s.queued > 0 && s.status !== "waiting" ? `working, ${s.queued} queued` : STATUS_TEXT[s.status]) : "idle";
    status.className = `hw-tag dock-thread-status${s && s.status !== "idle" ? (s.status === "waiting" ? " warn" : " live") : ""}`;
    // Stop ends the project's turn, so a chat without a project has none to stop.
    head.querySelector<HTMLElement>(".dock-stop")!.hidden = !s || s.status === "idle" || s.status === "waiting" || !this.current?.projectId;
  }

  private renderThread(): void {
    // Keep what the player typed and where the input was.
    const input = this.thread.querySelector<HTMLTextAreaElement>(".dock-input");
    if (input) this.draft = input.value;
    const hadFocus = input !== null && document.activeElement === input;
    this.thread.replaceChildren();
    this.chat.classList.toggle("has-thread", this.current !== null);
    if (!this.current) {
      el("div", "ac-empty dock-hint", "Pick a chat, or start one with New chat. An agent can have many chats.", this.thread);
      return;
    }
    const { agentId, projectId } = this.current;
    const head = el("div", "dock-thread-head", "", this.thread);
    const back = el("button", "ac-button hq-back dock-back", "‹", head);
    back.type = "button";
    back.title = "Sessions";
    back.addEventListener("click", () => {
      this.current = null;
      this.renderList();
      this.renderThread();
    });
    el("span", "dock-thread-title", `${this.name(agentId)} · ${projectId || "no project"}`, head);
    el("span", "hw-tag dock-thread-status", "idle", head);
    const stop = el("button", "ac-button deny dock-stop", "Stop", head);
    stop.type = "button";
    stop.addEventListener("click", () => {
      if (projectId) this.d.send({ type: "run.stop", projectId });
    });
    this.renderHead();

    const log = el("div", "dock-log", "", this.thread);
    const id = this.current.id;
    const msgs = id === null ? [] : [...(this.threads.get(id)?.values() ?? [])].sort((a, b) => a.id - b.id);
    if (msgs.length === 0) el("div", "ac-empty", projectId ? `Say what ${this.name(agentId)} should do on ${projectId}.` : `Ask ${this.name(agentId)} anything.`, log);
    for (const m of msgs) this.message(log, m);
    for (const a of (this.state?.approvals ?? []).filter((x) => x.projectId === projectId)) this.approval(log, a);

    const form = el("div", "dock-form", "", this.thread);
    const box = el("textarea", "dock-input", "", form);
    box.rows = 2;
    box.maxLength = MESSAGE_MAX;
    box.placeholder = `Message ${this.name(agentId)} (Enter sends, Shift+Enter new line)`;
    box.value = this.draft;
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit(box);
      } else if (e.key === "Escape") {
        this.fold();
      }
    });
    const sendBtn = el("button", "ac-button approve", "Send", form);
    sendBtn.type = "button";
    sendBtn.addEventListener("click", () => this.submit(box));
    log.scrollTop = log.scrollHeight;
    if (hadFocus) box.focus();
  }

  private message(log: HTMLElement, m: SessionMessageView): void {
    const row = el("div", `dock-msg ${m.kind}`, "", log);
    if (m.kind === "user") {
      el("div", "dock-bubble", m.text, row);
      if (m.status !== "done") el("div", "dock-meta", m.status === "queued" ? "queued" : "working…", row);
      return;
    }
    if (m.kind === "agent") {
      el("div", "dock-meta", this.name(m.author), row);
      markdown(m.text, el("div", "dock-bubble md", "", row));
      return;
    }
    el("div", "dock-line", m.kind === "report" ? `${this.name(m.author)}: ${m.text}` : m.text, row);
  }

  private approval(log: HTMLElement, a: ApprovalView): void {
    const row = el("div", "dock-msg approval-line", "", log);
    el("div", "dock-line", `${this.name(a.agentId)} asks: ${a.tool} ${a.argsPreview}`, row);
    if (!a.local) return void el("div", "dock-meta", "answer in your terminal", row);
    const bar = el("div", "hq-row-buttons", "", row);
    for (const [cls, label, decision] of [["approve", "Approve", "approved"], ["deny", "Deny", "denied"]] as const) {
      const b = el("button", `ac-button ${cls}`, label, bar);
      b.type = "button";
      b.addEventListener("click", () => this.d.send({ type: "approve", id: a.id, decision }));
    }
  }

  private submit(box: HTMLTextAreaElement): void {
    const text = box.value.trim();
    const id = this.current?.id ?? null;
    // A New chat not answered yet has no id: the message waits in the box.
    if (id === null || text.length < 1 || text.length > MESSAGE_MAX) return;
    if (!this.d.send({ type: "session.send", sessionId: id, text })) return;
    box.value = "";
    this.draft = "";
  }

  private focusInput(): void {
    this.thread.querySelector<HTMLTextAreaElement>(".dock-input")?.focus();
  }
}
