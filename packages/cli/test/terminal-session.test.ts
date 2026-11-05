import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MemoryStore } from "@agentcity/org";
import type { ServerMsg } from "@agentcity/world/shared";
import { runCli } from "../src/wire.js";
import { WebApprovals } from "../src/web-approver.js";
import { splitArgs, TerminalSession } from "../src/terminal-session.js";

let home: string;
let msgs: ServerMsg[];
let session: TerminalSession;

const outText = () => msgs.flatMap((m) => (m.type === "term.out" ? [m.text] : [])).join("");
const doneCodes = () => msgs.flatMap((m) => (m.type === "term.done" ? [m.code] : []));
const waitFor = async (pred: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 10 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(pred()).toBe(true);
};

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-term-"));
  msgs = [];
  const io = { input: new PassThrough(), output: new PassThrough(), error: new PassThrough() };
  expect(await runCli(["agent", "create", "ada", "--name", "Ada", "--persona", "You are Ada."], { home, io })).toBe(0);
  session = new TerminalSession({ home, approverFactory: new WebApprovals().factory, send: (m) => void msgs.push(m) });
});

describe("splitArgs", () => {
  it("splits on spaces and groups double quotes", () => {
    expect(splitArgs('run p "make a file" --agent ada')).toEqual(["run", "p", "make a file", "--agent", "ada"]);
  });
  it("keeps an escaped quote inside quotes", () => {
    expect(splitArgs('say "a \\"b\\" c"')).toEqual(["say", 'a "b" c']);
  });
  it("throws on an unclosed quote", () => {
    expect(() => splitArgs('run "oops')).toThrow("unclosed quote");
  });
});

describe("TerminalSession", () => {
  it("runs agent list and sends output then done 0", async () => {
    session.line("agent list");
    await waitFor(() => doneCodes().length === 1);
    expect(outText()).toContain("ada\tAda");
    expect(doneCodes()).toEqual([0]);
  });

  it("accepts a leading agentcity", async () => {
    session.line("agentcity agent list");
    await waitFor(() => doneCodes().length === 1);
    expect(outText()).toContain("ada\tAda");
  });

  it("refuses city with code 1", () => {
    session.line("city --port 0");
    expect(outText()).toContain("city cannot run inside the city");
    expect(doneCodes()).toEqual([1]);
  });

  it("gives commander's error for an unknown command", async () => {
    session.line("bogus");
    await waitFor(() => doneCodes().length === 1);
    expect(outText()).toContain("unknown command 'bogus'");
    expect(doneCodes()).toEqual([1]);
  });

  it("answers an empty line with done 0 and no output", () => {
    session.line("   ");
    expect(msgs).toEqual([{ type: "term.done", code: 0 }]);
  });

  it("reports an unclosed quote with code 1", () => {
    session.line('run "oops');
    expect(outText()).toContain("unclosed quote");
    expect(doneCodes()).toEqual([1]);
  });

  it("sends the next line to the y/n prompt of a running command", async () => {
    const memory = new MemoryStore(home);
    memory.append("ada", "likes tea");
    session.line("agent memory ada --clear");
    await waitFor(() => outText().includes("[y/N]"));
    expect(doneCodes()).toEqual([]);
    session.line("y");
    await waitFor(() => doneCodes().length === 1);
    expect(outText()).toContain("Cleared.");
    expect(memory.read("ada")).toBe("");
  });

  it("refuses secrets with code 1 and reads no key", () => {
    session.line("secrets set openai");
    expect(outText()).toContain("secrets cannot be set from the city; use a normal terminal");
    expect(doneCodes()).toEqual([1]);
  });

  it("run on a project claimed elsewhere gets project busy and code 1", () => {
    const claimed: string[] = [];
    const s = new TerminalSession({
      home, approverFactory: new WebApprovals().factory, send: (m) => void msgs.push(m),
      claimProject: (id) => (claimed.push(id), undefined),
    });
    s.line('run p "do it" --agent ada');
    expect(claimed).toEqual(["p"]);
    expect(outText()).toContain("project busy");
    expect(doneCodes()).toEqual([1]);
  });

  it("run releases its claim when the command ends", async () => {
    let released = 0;
    const s = new TerminalSession({
      home, approverFactory: new WebApprovals().factory, send: (m) => void msgs.push(m),
      claimProject: () => () => void released++,
    });
    s.line("run p goal --agent nobody");
    await waitFor(() => doneCodes().length === 1);
    expect(released).toBe(1);
  });

  it("runs a new command after the previous one finished", async () => {
    session.line("agent list");
    await waitFor(() => doneCodes().length === 1);
    session.line("agent list");
    await waitFor(() => doneCodes().length === 2);
  });

  it("close ends a running command", async () => {
    new MemoryStore(home).append("ada", "likes tea");
    session.line("agent memory ada --clear");
    await waitFor(() => outText().includes("[y/N]"));
    session.close();
    await waitFor(() => doneCodes().length === 1);
    expect(outText()).toContain("Kept.");
  });
});
