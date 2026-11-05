import type { DiffFileView, LogRow, TaskView } from "@agentcity/world/shared";
import { el } from "./dom.js";
import type { Send } from "./hq-panel.js";

/** The progress section shows this many rows at most: the newest. */
export const MAX_ROWS = 200;
const DOT: Record<TaskView["status"], string> = {
  doing: "run", review: "run", approval: "ask", blocked: "block", todo: "idle", done: "done", cancelled: "idle",
};
const LINE_SIGN = { add: "+", del: "-", ctx: " " } as const;

export function button(parent: HTMLElement | undefined, label: string, onClick: () => void, cls = "ac-button"): HTMLButtonElement {
  const b = el("button", cls, label, parent);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * A Roll back button with its confirm line. The button shows the line and sends nothing;
 * Yes calls onYes and hides the line; No hides it. Returns the button and the line.
 */
export function rollbackControls(
  buttons: HTMLElement, lineParent: HTMLElement, lineClass: string, onYes: () => void, disabled = false,
): { rollback: HTMLButtonElement; line: HTMLElement } {
  const line = el("div", lineClass, "", lineParent);
  line.hidden = true;
  el("span", "", "Undo the last run's changes?", line);
  button(line, "Yes", () => {
    line.hidden = true;
    onYes();
  }).disabled = disabled;
  button(line, "No", () => {
    line.hidden = true;
  });
  const rollback = button(buttons, "Roll back", () => {
    line.hidden = false;
  });
  rollback.disabled = disabled;
  return { rollback, line };
}

/** Appends the lines of one file's hunks, both line numbers on each line. */
export function diffLines(box: HTMLElement, file: DiffFileView): void {
  if (file.status === "binary") {
    el("div", "ac-empty", "binary file: no lines shown", box);
    return;
  }
  for (const hunk of file.hunks) {
    for (const line of hunk) {
      const row = el("div", `diff-line diff-${line.kind}`, "", box);
      el("span", "diff-no-old", line.oldNo === undefined ? "" : String(line.oldNo), row);
      el("span", "diff-no-new", line.newNo === undefined ? "" : String(line.newNo), row);
      el("span", "diff-sign", LINE_SIGN[line.kind], row);
      el("span", "diff-text", line.text, row);
    }
  }
  if (file.truncated) el("div", "diff-cut", "Cut: more than 2000 lines in this file.", box);
}

/** What the thread needs besides the task and its log. */
export interface ThreadOpts {
  /** Name of the assigned agent. Defaults to the agent id. */
  agentName?: string;
  /** Role of the assigned agent, shown next to the name. */
  role?: string;
  /** The agent Open chat talks to. Defaults to the assignee. */
  chatAgent?: string;
  /** Runs when Open chat is pressed. Without it, or without an agent, the button is not drawn. */
  chat?: (ref: { agentId: string; projectId: string; taskId: string }) => void;
  /** Label and action of the back link in the header. */
  back?: { label: string; go: () => void };
  /** The task's diff, or null while it is not loaded. */
  diff?: DiffFileView[] | null;
  /** False leaves the Changes list out under the thread, for a panel that shows the diff in its own tab. Default true. */
  changes?: boolean;
  /** True until the task's log arrived: the progress reads "loading…" in place of "nothing yet". */
  loading?: boolean;
  /** Current time, for the age in the header. */
  now?: number;
  /** False leaves out Retry, Cancel, Roll back and the diff (the goal board draws its own). Default true. */
  actions?: boolean;
  /** False leaves the answer box out of the question block (the goal board draws its own). Default true. */
  answerBox?: boolean;
}

const CITY_RE = /^(started|stopped):/;

/** Index of the first row of the last run: the last "started:" row, else 0. */
function runStart(log: LogRow[]): number {
  for (let i = log.length - 1; i >= 0; i--) if (log[i]!.text.startsWith("started:")) return i;
  return 0;
}

/** "3 min", "2 h", "4 d" since an ISO time. */
export function since(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** Call before the box leaves the document: a detached element forgets how far it was scrolled. */
export function keepScroll(box: HTMLElement): void {
  const p = box.querySelector<HTMLElement>(".tt-progress");
  if (!p) return;
  box.dataset.stick = p.scrollHeight - p.scrollTop - p.clientHeight < 40 ? "1" : "0";
  box.dataset.top = String(p.scrollTop);
}

const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * One task as a thread: header, the agent's reasoning and tool calls, its question, then the footer with Pause and
 * Open chat, and under it Retry, Cancel, Roll back and the diff. Replaces the contents of `box`. The progress stays
 * scrolled to the bottom when it was at the bottom, and a half-typed answer stays in its box.
 */
export function renderThread(box: HTMLElement, task: TaskView, log: LogRow[], send: Send, opts: ThreadOpts = {}): void {
  const old = box.querySelector<HTMLInputElement>(".tt-answer-input");
  const typed = old?.value ?? "";
  const hadFocus = old !== null && document.activeElement === old;
  const typedNote = box.querySelector<HTMLInputElement>(".tt-review-input")?.value ?? "";
  // keepScroll saved the position while the box was attached; a detached box cannot be measured.
  const live = box.querySelector<HTMLElement>(".tt-progress");
  const saved = box.dataset.stick !== undefined;
  const stuck = saved
    ? box.dataset.stick === "1"
    : live ? live.scrollHeight - live.scrollTop - live.clientHeight < 40 : true;
  const kept = saved ? Number(box.dataset.top ?? "0") : live ? live.scrollTop : 0;
  box.replaceChildren();
  delete box.dataset.stick;
  delete box.dataset.top;

  const agent = opts.agentName ?? task.assignee ?? "no agent";
  const rows = log.slice(-MAX_ROWS);
  const first = runStart(log);
  const run = log.slice(first);
  const steps = run.filter((r) => r.kind === "tool").length;
  const startedAt = log[first]?.ts ?? task.createdAt;

  // Header
  const head = el("div", "tt-head", "", box);
  const line = el("div", "tt-line", "", head);
  if (opts.back) {
    const b = el("button", "ac-button hq-back tt-back", opts.back.label, line);
    b.type = "button";
    b.addEventListener("click", opts.back.go);
  }
  el("span", "tt-spacer", "", line);
  el("span", "tt-meta tt-steps", `step ${steps} · ${since(startedAt, opts.now ?? Date.now())}`, line);
  const titleRow = el("div", "tt-line", "", head);
  el("span", `st-dot ${DOT[task.status]}`, "", titleRow);
  el("span", "ac-title tt-title", task.title, titleRow);
  const sub = [agent + (opts.role ? ` · ${opts.role}` : ""), task.branch ? `branch ${task.branch}` : "", task.status].filter(Boolean).join(" · ");
  el("div", "tt-meta tt-sub", sub, head);

  // Progress
  el("div", "ac-sec", "Progress", box);
  const progress = el("div", "tt-progress", "", box);
  if (log.length > rows.length) el("div", "tt-meta tt-cut", `Older rows hidden: showing the last ${MAX_ROWS} of ${log.length}.`, progress);
  if (rows.length === 0) el("div", "ac-empty", opts.loading ? "loading…" : "nothing yet", progress);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind === "text" && CITY_RE.test(r.text)) {
      el("div", "tt-msg tt-city", `city: ${r.text}`, progress);
    } else if (r.kind === "text") {
      const m = el("div", "tt-msg tt-think", "", progress);
      el("div", "tt-who", `${agent} thinks`, m);
      m.append(r.text);
    } else if (r.kind === "error") {
      const m = el("div", "tt-msg tt-error", "", progress);
      el("div", "tt-who", "error", m);
      m.append(r.text);
    } else {
      const isTool = r.kind === "tool";
      const next = isTool ? rows[i + 1] : undefined;
      const result = next?.kind === "result" ? next : undefined;
      if (result) i++;
      const space = isTool ? r.text.indexOf(" ") : -1;
      const name = isTool ? (space < 0 ? r.text : r.text.slice(0, space)) : "result";
      const arg = isTool ? (space < 0 ? "" : r.text.slice(space + 1)) : r.text;
      const m = el("div", "tt-msg tt-tool", "", progress);
      el("div", "tt-who", name, m);
      el("div", "tt-result", clip([arg, result?.text ?? ""].filter(Boolean).join(" · ")), m);
    }
  }

  // The agent's question
  if (task.status === "blocked" && task.blockedReason) {
    const ask = el("div", "tt-msg tt-ask", "", box);
    el("div", "tt-who", `${agent} asks you`, ask);
    ask.append(task.blockedReason);
    if (opts.answerBox !== false) {
      const row = el("div", "tt-answer", "", ask);
      const input = el("input", "tt-answer-input", "", row);
      input.placeholder = "Answer the agent's question";
      input.maxLength = 4000;
      input.dataset.keep = "answer";
      input.value = typed;
      const answer = (): void => {
        const text = input.value.trim();
        if (text === "") return;
        if (send({ type: "task.answer", taskId: task.id, text })) input.value = "";
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") answer();
      });
      const b = el("button", "ac-button approve", "Answer", row);
      b.type = "button";
      b.addEventListener("click", answer);
      if (hadFocus) input.focus();
    }
  }

  // Footer
  const foot = el("div", "tt-foot", "", box);
  const footButton = (label: string, run: () => void, cls: string): void => {
    const b = el("button", `ac-button ${cls}`, label, foot);
    b.type = "button";
    b.addEventListener("click", run);
  };
  if (task.status !== "done" && task.status !== "cancelled") {
    footButton(task.held ? "Resume" : "Pause", () => void send({ type: "task.action", taskId: task.id, action: task.held ? "resume" : "pause" }), "tt-pause");
  }
  const agentId = opts.chatAgent ?? task.assignee;
  const chat = opts.chat;
  if (chat && agentId) footButton("Open chat", () => chat({ agentId, projectId: task.projectId, taskId: task.id }), "tt-chat");

  if (opts.actions === false) {
    progress.scrollTop = stuck ? progress.scrollHeight : kept;
    return;
  }

  // Under the thread: Retry, Cancel, Roll back, the diff
  const actions = el("div", "tt-actions", "", box);
  const doing = (action: "retry" | "cancel" | "rollback") => (): void => void send({ type: "task.action", taskId: task.id, action });
  // An approval waits for the review answer. The same three answers as the Inbox; the note is optional except for Send back.
  if (task.status === "approval") {
    const note = el("input", "tt-review-input", "", actions);
    note.placeholder = "Notes for the agent (optional)";
    note.maxLength = 4000;
    note.value = typedNote;
    const review = (option: "merge" | "changes" | "reject") => (): void => {
      const text = note.value.trim();
      if (option === "changes" && !text) return;
      void send({ type: "review.answer", taskId: task.id, option, ...(text ? { text } : {}) });
    };
    button(actions, "Merge", review("merge"), "ac-button approve");
    button(actions, "Send back", review("changes"));
    button(actions, "Reject", review("reject"), "ac-button deny");
  }
  const actionButton = (label: string, show: boolean, action: "retry" | "cancel"): void => {
    if (!show) return;
    const b = el("button", `ac-button tt-${action}`, label, actions);
    b.type = "button";
    b.addEventListener("click", doing(action));
  };
  actionButton("Retry", ["blocked", "done", "cancelled"].includes(task.status), "retry");
  actionButton("Cancel", ["todo", "doing", "review", "approval", "blocked"].includes(task.status), "cancel");
  if (task.checkpoint !== null && ["todo", "blocked", "approval"].includes(task.status)) {
    const { rollback } = rollbackControls(actions, box, "tt-confirm", doing("rollback"));
    rollback.classList.add("tt-rollback");
  }

  if (opts.changes !== false) {
    const files = opts.diff;
    el("div", "ac-sec", "Changes", box);
    const changes = el("div", "tt-diff", "", box);
    if (files === undefined || files === null) el("div", "ac-empty", "loading changes…", changes);
    else if (files.length === 0) el("div", "ac-empty", "no file changes", changes);
    else {
      const index = Math.min(Number(box.dataset.diffIndex ?? "0"), files.length - 1);
      const tabs = el("div", "tt-diff-files", "", changes);
      files.forEach((f, i) => {
        const b = el("button", `ac-tab diff-file${i === index ? " active" : ""}`, `${f.path} +${f.additions} -${f.deletions}`, tabs);
        b.type = "button";
        b.addEventListener("click", () => {
          box.dataset.diffIndex = String(i);
          renderThread(box, task, log, send, opts);
        });
      });
      const file = files[index]!;
      const lines = el("div", "diff-lines", "", changes);
      el("div", "tt-meta", `${file.status}${file.truncated ? " · cut" : ""}`, lines);
      diffLines(lines, file);
    }
  }

  progress.scrollTop = stuck ? progress.scrollHeight : kept;
}
