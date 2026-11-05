import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { FakeProvider, type ChatResponse } from "@agentcity/core";
import { loadProjectConfig, type ApprovalStatus } from "@agentcity/safety";
import { runCli, type CliDeps } from "../src/wire.js";
import { branchName } from "../src/workspace.js";

const usage = { inputTokens: 1, outputTokens: 1 };
const call = (id: string, name: string, args: unknown): ChatResponse => ({ text: "", toolCalls: [{ id, name, args }], usage });
const done: ChatResponse = { text: "finished", toolCalls: [], usage };

let home: string;
let repo: string;
let out: string;
let err: string;
let asked: string[];
let answer: ApprovalStatus;

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();

function deps(provider?: FakeProvider): CliDeps {
  const o = new PassThrough();
  const e = new PassThrough();
  o.on("data", (d: Buffer) => (out += d.toString()));
  e.on("data", (d: Buffer) => (err += d.toString()));
  return {
    home,
    io: { input: new PassThrough(), output: o, error: e },
    providerOverride: provider,
    registerInterrupt: () => () => undefined,
    exit: () => undefined,
    approverFactory: () => ({
      decide: async (req) => {
        asked.push(req.tool);
        return answer;
      },
      cancel: () => undefined,
      close: () => undefined,
    }),
  };
}
const cli = (args: string[], provider?: FakeProvider) => runCli(args, deps(provider));

async function setup(folder = repo) {
  expect(await cli(["init", "demo", "--path", folder])).toBe(0);
  expect(await cli(["agent", "create", "ada", "--name", "Ada", "--model", "lmstudio/test", "--persona", "You are Ada."])).toBe(0);
  expect(await cli(["grant", "demo", "ada"])).toBe(0);
}
const config = () => {
  const c = loadProjectConfig(home, "demo");
  if (!c.ok) throw new Error(c.error);
  return c.config;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-wsh-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-repo-"));
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "readme.md"), "hi\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  out = "";
  err = "";
  asked = [];
  answer = "approved";
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("linking a folder", () => {
  it("init --path on a git repo links it with edits auto and every built-in tool", async () => {
    await setup();
    const c = config();
    expect(c.workspace).toBe(fs.realpathSync(repo));
    expect(c.edits).toBe("auto");
    expect(c.allowedTools).toEqual(expect.arrayContaining(["list_files", "search_files", "edit_file", "delete_file", "run_command"]));
    expect(out).toContain("each run gets its own branch");
  });

  it("a folder without git gets edits ask; a missing folder fails", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ac-plain-"));
    try {
      await setup(plain);
      expect(config().edits).toBe("ask");
      expect(await cli(["init", "other", "--path", path.join(plain, "nope")])).toBe(1);
      expect(err).toContain("No folder at");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("project limits saves one limit and leaves the others", async () => {
    expect(await cli(["init", "demo"])).toBe(0);
    expect(await cli(["project", "limits", "demo", "parallelJobs", "0"])).toBe(0);
    expect(out).toContain("Limit parallelJobs for demo: 0");
    expect(config().limits).toEqual({ stepsPerJob: 0, parallelJobs: 0, reminders: 1, testFixes: 1, sendBacks: 2, conflicts: 1 });
    expect(await cli(["project", "limits", "demo", "sendBacks", "5"])).toBe(0);
    expect(config().limits.sendBacks).toBe(5);
    expect(config().limits.parallelJobs).toBe(0);
  });

  it("project limits rejects an unknown name, a negative number and a bad number", async () => {
    expect(await cli(["init", "demo"])).toBe(0);
    expect(await cli(["project", "limits", "demo", "retries", "2"])).toBe(1);
    expect(err).toContain("Limit must be one of stepsPerJob, parallelJobs, reminders, testFixes, sendBacks, conflicts.");
    expect(await cli(["project", "limits", "demo", "reminders", "-1"])).toBe(1);
    expect(err).toContain("Limit must be a whole number of 0 or more.");
    expect(await cli(["project", "limits", "demo", "reminders", "two"])).toBe(1);
    expect(config().limits.reminders).toBe(1);
  });

  it("project budget saves the new shape", async () => {
    expect(await cli(["init", "demo"])).toBe(0);
    expect(await cli(["project", "budget", "demo", "50000", "0.5"])).toBe(0);
    expect(out).toContain("Budget for demo: 50000 tokens per job, $0.5 per day");
    expect(config().budget).toEqual({ jobTokens: 50000, dayUsd: 0.5 });
    expect("perAgent" in config()).toBe(false);
  });

  it("project budget with a bad number fails", async () => {
    expect(await cli(["init", "demo"])).toBe(0);
    expect(await cli(["project", "budget", "demo", "lots", "1"])).toBe(1);
    expect(err).toContain("Budget must be two numbers of 0 or more.");
    expect(await cli(["project", "budget", "demo", "100", "-1"])).toBe(1);
    expect(config().budget).toEqual({ jobTokens: 200000, dayUsd: 1 });
  });

  it("project commands change the edit mode, lists and link", async () => {
    expect(await cli(["init", "demo"])).toBe(0);
    expect(await cli(["project", "link", "demo", repo])).toBe(0);
    expect(await cli(["project", "edits", "demo", "ask"])).toBe(0);
    expect(await cli(["project", "safe", "demo", "add", "npm install"])).toBe(0);
    expect(await cli(["project", "protect", "demo", "add", "package.json"])).toBe(0);
    expect(await cli(["project", "protect", "demo", "remove", ".github/**"])).toBe(0);
    let c = config();
    expect(c.edits).toBe("ask");
    expect(c.safeCommands).toContain("npm install");
    expect(c.protectedPaths).toEqual([".env*", ".git/**", "package.json"]);
    expect(await cli(["project", "show", "demo"])).toBe(0);
    expect(out).toContain("edits: ask");
    expect(await cli(["project", "edits", "demo", "maybe"])).toBe(1);
    expect(await cli(["project", "unlink", "demo"])).toBe(0);
    c = config();
    expect(c.workspace).toBeUndefined();
  });
});

describe("runs in a linked git repo", () => {
  it("work on a new branch, write in the folder and commit with safe commands, no asks", async () => {
    await setup();
    const p = new FakeProvider([
      call("1", "write_file", { path: "src/a.txt", content: "A" }),
      call("2", "edit_file", { path: "readme.md", old: "hi", new: "hello" }),
      call("3", "run_command", { command: "git add -A" }),
      call("4", "run_command", { command: 'git -c user.name=t -c user.email=t@t commit -q -m "agent work"' }),
      done,
    ]);
    // git -c ... does not start with a safe entry, so allow it for this test
    expect(await cli(["project", "safe", "demo", "add", "git -c user.name=t -c user.email=t@t commit"])).toBe(0);
    expect(await cli(["run", "demo", "--agent", "ada", "go"], p)).toBe(0);
    expect(asked).toEqual([]);
    const branch = git("branch", "--show-current");
    expect(branch).toMatch(/^agent\/ada-\d{8}-\d{6}$/);
    expect(out).toContain(`working on branch ${branch}`);
    expect(git("log", "-1", "--format=%s")).toBe("agent work");
    expect(git("show", "main:readme.md")).toBe("hi");
    expect(fs.readFileSync(path.join(repo, "src", "a.txt"), "utf8")).toBe("A");
  });

  it("a folder with uncommitted changes stops the run before any model call", async () => {
    await setup();
    fs.writeFileSync(path.join(repo, "readme.md"), "dirty\n");
    const p = new FakeProvider([done]);
    expect(await cli(["run", "demo", "--agent", "ada", "go"], p)).toBe(1);
    expect(err).toContain("1 uncommitted change. Commit or stash them, then run again.");
    expect(git("branch", "--show-current")).toBe("main");
  });

  it("asks for unsafe commands, protected files, deletes and --ask-edits", async () => {
    await setup();
    answer = "denied";
    const p = new FakeProvider([
      call("1", "run_command", { command: "npm install" }),
      call("2", "write_file", { path: ".env", content: "X=1" }),
      call("3", "delete_file", { path: "readme.md" }),
      call("4", "write_file", { path: "ok.txt", content: "fine" }),
      done,
    ]);
    expect(await cli(["run", "demo", "--agent", "ada", "go"], p)).toBe(0);
    expect(asked).toEqual(["run_command", "write_file", "delete_file"]);
    expect(fs.existsSync(path.join(repo, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "readme.md"))).toBe(true);
    expect(fs.readFileSync(path.join(repo, "ok.txt"), "utf8")).toBe("fine");

    git("add", "-A");
    git("commit", "-q", "-m", "keep");
    asked = [];
    const q = new FakeProvider([call("1", "write_file", { path: "b.txt", content: "b" }), done]);
    expect(await cli(["run", "demo", "--agent", "ada", "--ask-edits", "go"], q)).toBe(0);
    expect(asked).toEqual(["write_file"]);
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
  });
});

describe("branchName", () => {
  it("uses the agent id and local time", () => {
    expect(branchName("ada", new Date(2026, 10, 1, 9, 5, 7))).toBe("agent/ada-20261101-090507");
  });
});
