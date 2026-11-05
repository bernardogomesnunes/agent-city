import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { hqAllowed, hqConfig, runHqCommand } from "../src/hq.js";
import { scanPorts } from "../src/ports.js";
import { readSecrets } from "../src/secrets.js";
import { agentBranches, mergeAgentBranch } from "../src/workspace.js";

let home: string;
let repo: string;
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const saved: Record<string, string | undefined> = {};
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (file: string, text: string, msg: string) => {
  fs.writeFileSync(path.join(repo, file), text);
  git("add", ".");
  git("commit", "-q", "-m", msg);
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ID)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-hub-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-hubrepo-"));
  git("init", "-q", "-b", "main");
  commit("readme.md", "hi\n", "init");
});
afterEach(() => {
  for (const k of Object.keys(ID)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("agent branches", () => {
  it("lists unmerged agent branches with commit count and stat, then merges one into main", () => {
    git("switch", "-q", "-c", "agent/ada-20261101-120000");
    commit("a.txt", "a\n", "add a");
    git("switch", "-q", "-c", "other");
    git("switch", "-q", "main");
    const list = agentBranches(repo);
    expect(list.map((b) => b.name)).toEqual(["agent/ada-20261101-120000"]);
    expect(list[0]).toMatchObject({ ahead: 1, subject: "add a" });
    expect(list[0]!.stat).toContain("1 file changed");

    git("switch", "-q", "agent/ada-20261101-120000");
    const r = mergeAgentBranch(repo, "agent/ada-20261101-120000");
    expect(r).toEqual({ ok: true, base: "main" });
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(true);
    expect(agentBranches(repo)).toEqual([]);
  });

  it("refuses a dirty tree and a branch outside agent/", () => {
    git("switch", "-q", "-c", "agent/ada-1");
    commit("a.txt", "a\n", "add a");
    fs.writeFileSync(path.join(repo, "dirty.txt"), "x");
    expect(mergeAgentBranch(repo, "agent/ada-1")).toMatchObject({ ok: false });
    expect(mergeAgentBranch(repo, "main")).toMatchObject({ ok: false, detail: "No agent branch main." });
  });

  it("aborts a conflicting merge and leaves the repo as it was", () => {
    git("switch", "-q", "-c", "agent/ada-2");
    commit("readme.md", "agent\n", "agent edit");
    git("switch", "-q", "main");
    commit("readme.md", "user\n", "user edit");
    git("switch", "-q", "agent/ada-2");
    const r = mergeAgentBranch(repo, "agent/ada-2");
    expect(r.ok).toBe(false);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/ada-2");
    expect(git("status", "--porcelain")).toBe("");
  });
});

describe("HQ commands", () => {
  it("allows settings commands and refuses run, city and unknown ones", () => {
    expect(hqAllowed(["agent", "create", "x"])).toBe(true);
    expect(hqAllowed(["project", "merge", "p", "agent/x"])).toBe(true);
    expect(hqAllowed(["project", "remove", "p"])).toBe(true);
    expect(hqAllowed(["project", "limits", "p", "reminders", "2"])).toBe(true);
    expect(hqAllowed(["init", "p"])).toBe(true);
    expect(hqAllowed(["run", "p", "x", "goal"])).toBe(false);
    expect(hqAllowed(["city"])).toBe(false);
    expect(hqAllowed(["secrets", "list"])).toBe(false);
    expect(hqAllowed([])).toBe(false);
  });

  it("stores a key from hidden input and never echoes it", async () => {
    const key = "sk-test-0123456789abcdef";
    const r = await runHqCommand(home, ["secrets", "set", "api-groq"], key);
    expect(r.code).toBe(0);
    expect(r.text).not.toContain(key);
    expect(readSecrets(home)["api-groq"]).toBe(key);
    expect(hqConfig(home).secrets).toEqual(["api-groq"]);
  });

  it("refuses a command outside the list without running it", async () => {
    const r = await runHqCommand(home, ["run", "p", "a", "goal"], undefined);
    expect(r).toEqual({ code: 1, text: "HQ cannot run: run p" });
  });

  it("config shows projects with their waiting branches", async () => {
    expect((await runHqCommand(home, ["init", "site", "--path", repo], undefined)).code).toBe(0);
    git("switch", "-q", "-c", "agent/ada-3");
    commit("b.txt", "b\n", "add b");
    git("switch", "-q", "main");
    const p = hqConfig(home).projects.find((x) => x.id === "site")!;
    expect(p.base).toBe("main");
    expect(p.branches.map((b) => b.name)).toEqual(["agent/ada-3"]);
    const merged = await runHqCommand(home, ["project", "merge", "site", "agent/ada-3"], undefined);
    expect(merged).toEqual({ code: 0, text: "Merged agent/ada-3 into main." });
    expect(hqConfig(home).projects.find((x) => x.id === "site")!.branches).toEqual([]);
  });
});

describe("scanPorts", () => {
  it("finds a local HTTP server with its page title and skips closed ports", async () => {
    const server = http.createServer((_q, s) => s.end("<html><title>My site</title></html>"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const closed = port === 65000 ? 65001 : 65000;
      expect(await scanPorts([], [port, closed])).toEqual([{ port, title: "My site" }]);
      expect(await scanPorts([port], [port])).toEqual([]);
    } finally {
      server.close();
    }
  });
});
