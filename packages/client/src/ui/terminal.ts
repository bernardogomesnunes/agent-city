import { el } from "./dom.js";
import type { Send } from "./hq-panel.js";

export const TERM_MAX_LINES = 500;

/** Terminal panel: output area (last 500 lines) and one input line. Key backtick toggles it. */
export class Terminal {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly outEl: HTMLElement;
  private readonly runningLabel: HTMLElement;
  private lines = [""];
  private running = false;
  private open_ = false;

  constructor(
    parent: HTMLElement,
    private readonly send: Send,
    private readonly onOpenChange: (open: boolean) => void = () => undefined,
  ) {
    this.root = el("div", "ac-box terminal", "", parent);
    this.root.hidden = true;
    el("div", "ac-title", "Terminal", this.root);
    this.outEl = el("pre", "term-out", "", this.root);
    this.runningLabel = el("div", "term-running", "running...", this.root);
    this.runningLabel.hidden = true;
    this.input = el("input", "term-in", "", this.root);
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.placeholder = "agentcity command";
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submit();
    });
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Number of output lines kept. */
  get lineCount(): number {
    return this.lines.length;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.root.hidden = false;
    this.input.focus();
    this.onOpenChange(true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.hidden = true;
    this.input.blur();
    this.onOpenChange(false);
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  /** Appends server text. A chunk without a newline continues the last line. */
  out(text: string): void {
    const parts = text.split("\n");
    this.lines[this.lines.length - 1] += parts[0]!;
    for (const p of parts.slice(1)) this.lines.push(p);
    if (this.lines.length > TERM_MAX_LINES) this.lines = this.lines.slice(this.lines.length - TERM_MAX_LINES);
    this.outEl.textContent = this.lines.join("\n");
    this.outEl.scrollTop = this.outEl.scrollHeight;
  }

  /** The command finished with `code`. */
  done(code: number): void {
    this.running = false;
    this.runningLabel.hidden = true;
    if (code !== 0) this.out(`[exit ${code}]\n`);
  }

  /** The connection dropped: no `term.done` will come, so unlock the input. */
  reset(): void {
    this.running = false;
    this.runningLabel.hidden = true;
  }

  private submit(): void {
    const line = this.input.value.trim();
    if (!line) return;
    if (!this.send({ type: "term.in", line })) return;
    this.input.value = "";
    if (this.running) {
      // Input for the running command (a y/n answer): shown as plain text after its prompt.
      this.out(`${line}
`);
      return;
    }
    this.out(`> ${line}
`);
    this.running = true;
    this.runningLabel.hidden = false;
  }
}
