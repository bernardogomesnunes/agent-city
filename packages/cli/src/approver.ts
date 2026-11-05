import readline from "node:readline";
import type { ApprovalRequest, ApprovalStatus, Approver } from "@agentcity/safety";

/** An approver that can drop its pending prompts (`cancel`) and release its resources (`close`). */
export interface ClosableApprover extends Approver { cancel(): void; close(): void }

export interface TerminalIo { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }

/**
 * One readline over an input. `buffer: true` keeps lines that arrive with no waiter (one approver, one run).
 * `buffer: false` drops them, so a line typed for one asker never answers a later asker (a tree of runs).
 */
export class LineReader {
  private rl?: readline.Interface;
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;

  constructor(private readonly input: NodeJS.ReadableStream, private readonly buffer: boolean) {}

  private open(): void {
    if (this.rl) return;
    this.rl = readline.createInterface({ input: this.input, terminal: false });
    this.rl.on("line", (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else if (this.buffer) this.lines.push(l);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w("");
    });
  }

  /** Waits for the next line. `release()` answers the wait with an empty line. */
  next(): { line: Promise<string>; release: () => void } {
    this.open();
    const queued = this.lines.shift();
    if (queued !== undefined) return { line: Promise.resolve(queued), release: () => undefined };
    if (this.closed) return { line: Promise.resolve(""), release: () => undefined };
    let resolve!: (l: string) => void;
    const line = new Promise<string>((r) => (resolve = r));
    this.waiters.push(resolve);
    return {
      line,
      release: () => {
        const i = this.waiters.indexOf(resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve("");
      },
    };
  }

  close(): void {
    this.rl?.close();
  }
}

/** Prints the request, reads one line from input. "y" or "yes" approves, anything else denies. */
export class TerminalApprover implements ClosableApprover {
  private readonly reader: LineReader;
  private readonly ownsReader: boolean;
  private releases = new Set<() => void>();
  private cancelled = false;

  /** Pass `reader` to share one line reader across approvers. Without it the approver owns one. */
  constructor(
    private readonly io: TerminalIo,
    private readonly agentName?: string,
    reader?: LineReader,
  ) {
    this.ownsReader = reader === undefined;
    this.reader = reader ?? new LineReader(io.input, true);
  }

  async decide(req: ApprovalRequest & { id: number }): Promise<ApprovalStatus> {
    if (this.cancelled) return "denied";
    const who = this.agentName ?? req.agentId;
    this.io.output.write(
      `${who} wants to run ${req.tool} (tier ${req.tier}, estimated cost $${req.estimatedUsd.toFixed(4)})\n` +
        `${JSON.stringify(req.args, null, 2)}\n` +
        `Approve? [y/N] `,
    );
    const w = this.reader.next();
    this.releases.add(w.release);
    const answer = (await w.line).trim().toLowerCase();
    this.releases.delete(w.release);
    this.io.output.write("\n");
    return answer === "y" || answer === "yes" ? "approved" : "denied";
  }

  /** Answers every waiting prompt with a denial and denies every later prompt at once. Used on interrupt. */
  cancel(): void {
    this.cancelled = true;
    for (const r of [...this.releases]) r();
  }

  close(): void {
    if (this.ownsReader) this.reader.close();
  }
}
