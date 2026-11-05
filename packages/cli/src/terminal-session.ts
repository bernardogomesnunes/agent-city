import { PassThrough, Writable } from "node:stream";
import type { Provider } from "@agentcity/core";
import type { ServerMsg } from "@agentcity/world/shared";
import type { ClosableApprover } from "./approver.js";
import { runCli } from "./wire.js";

/** Splits on spaces. Double quotes group, and `\"` inside quotes is a quote. */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let cur = "";
  let has = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === "\\" && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') {
      quoted = true;
      has = true;
    } else if (c === " " || c === "\t") {
      if (has) args.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quoted) throw new Error("unclosed quote");
  if (has) args.push(cur);
  return args;
}

export interface TerminalDeps {
  home: string;
  providerOverride?: Provider;
  approverFactory: (name: string) => ClosableApprover;
  send: (msg: ServerMsg) => void;
  /** Marks a project busy for a terminal `run`. Undefined means another run holds it. Call the result to release. */
  claimProject?: (projectId: string) => (() => void) | undefined;
}

/** The project argument of `run <project> <goal>`: the first positional after `run`, skipping option values. */
function runProject(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--agent" || a === "--model") i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

interface Running {
  input: PassThrough;
  interrupt?: () => void | Promise<void>;
}

/** One per websocket client. Runs `agentcity` subcommands in this process, one at a time. */
export class TerminalSession {
  private running?: Running;

  constructor(private readonly deps: TerminalDeps) {}

  line(text: string): void {
    if (this.running) {
      this.running.input.write(text + "\n");
      return;
    }
    let argv: string[];
    try {
      argv = splitArgs(text);
    } catch (e) {
      return this.finish(e instanceof Error ? e.message : String(e), 1);
    }
    if (argv[0] === "agentcity") argv.shift();
    if (argv.length === 0) return this.deps.send({ type: "term.done", code: 0 });
    if (argv[0] === "city") return this.finish("city cannot run inside the city", 1);
    if (argv[0] === "secrets") return this.finish("secrets cannot be set from the city; use a normal terminal", 1);
    let release: (() => void) | undefined;
    const project = argv[0] === "run" ? runProject(argv) : undefined;
    if (project !== undefined && this.deps.claimProject) {
      release = this.deps.claimProject(project);
      if (!release) return this.finish("project busy", 1);
    }
    void this.run(argv, release);
  }

  /** Ends the input of a running command and fires its interrupt handler, so waiting commands stop. */
  close(): void {
    const r = this.running;
    if (!r) return;
    r.input.end();
    void r.interrupt?.();
  }

  private finish(message: string, code: number): void {
    this.deps.send({ type: "term.out", text: message + "\n" });
    this.deps.send({ type: "term.done", code });
  }

  private async run(argv: string[], release?: () => void): Promise<void> {
    const running: Running = { input: new PassThrough() };
    this.running = running;
    const sink = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        this.deps.send({ type: "term.out", text: chunk.toString() });
        cb();
      },
    });
    let code: number;
    try {
      code = await runCli(argv, {
        home: this.deps.home,
        io: { input: running.input, output: sink, error: sink },
        approverFactory: this.deps.approverFactory,
        providerOverride: this.deps.providerOverride,
        registerInterrupt: (h) => {
          running.interrupt = h;
          return () => {
            running.interrupt = undefined;
          };
        },
        exit: () => undefined,
      });
    } catch (e) {
      this.deps.send({ type: "term.out", text: (e instanceof Error ? e.message : String(e)) + "\n" });
      code = 1;
    }
    this.running = undefined;
    release?.();
    running.input.end();
    this.deps.send({ type: "term.done", code });
  }
}
