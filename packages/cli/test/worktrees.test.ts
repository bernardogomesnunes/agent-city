import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changedFiles,
  commitAll,
  commitExists,
  ensureRepo,
  headSha,
  mergeTask,
  openWorktree,
  removeAgentBranches,
  removeWorktree,
  resetTo,
  runTests,
  testCommand,
  worktreePath,
} from "../src/worktrees.js";

let home: string;
let repo: string;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const branchExists = (name: string) => {
  try {
    sh(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-wt-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-wt-repo-"));
  sh(repo, "init", "-q", "-b", "main");
  write(repo, "readme.md", "hi\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("ensureRepo", () => {
  it("runs git init and one empty commit in a folder without git, once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-wt-plain-"));
    try {
      ensureRepo(dir);
      expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
      expect(sh(dir, "rev-list", "--count", "HEAD")).toBe("1");
      ensureRepo(dir);
      expect(sh(dir, "rev-list", "--count", "HEAD")).toBe("1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commits the files already in the folder, so worktrees get them and the folder stays clean", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-wt-files-"));
    try {
      fs.writeFileSync(path.join(dir, "index.html"), "<p>pong</p>");
      ensureRepo(dir);
      expect(sh(dir, "ls-files")).toBe("index.html");
      expect(sh(dir, "status", "--porcelain")).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openWorktree", () => {
  it("adds a worktree on a new branch and returns the same worktree on the second call", () => {
    const wt = worktreePath(home, "demo", "t2");
    expect(wt).toBe(path.join(home, "worktrees", "demo", "t2"));
    const first = openWorktree(repo, wt, "agent/ada/t2");
    expect(first).toEqual({ path: wt, branch: "agent/ada/t2", base: "main" });
    expect(sh(wt, "branch", "--show-current")).toBe("agent/ada/t2");
    expect(openWorktree(repo, wt, "agent/ada/t2")).toEqual(first);
  });
});

describe("commitAll and changedFiles", () => {
  it("counts changed files, commits them under the author, and commits nothing twice", () => {
    const wt = openWorktree(repo, worktreePath(home, "demo", "t2"), "agent/ada/t2").path;
    expect(changedFiles(wt, "main")).toBe(0);
    write(wt, "a.txt", "A\n");
    write(wt, "b.txt", "B\n");
    expect(changedFiles(wt, "main")).toBe(2);
    expect(commitAll(wt, "AgentCity Dev", "t2: write files")).toEqual({ committed: true, files: 2 });
    expect(sh(wt, "log", "-1", "--format=%an")).toBe("AgentCity Dev");
    expect(sh(wt, "log", "-1", "--format=%s")).toBe("t2: write files");
    expect(changedFiles(wt, "main")).toBe(2);
    expect(commitAll(wt, "AgentCity Dev", "t2: nothing")).toEqual({ committed: false, files: 0 });
  });

  it("leaves protected files out of the commit", () => {
    const wt = openWorktree(repo, worktreePath(home, "demo", "t2"), "agent/ada/t2").path;
    write(wt, "a.txt", "A\n");
    write(wt, ".env", "KEY=1\n");
    expect(commitAll(wt, "AgentCity Dev", "t2: a", [".env*"])).toEqual({ committed: true, files: 1 });
    expect(sh(wt, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt");
  });
});

describe("mergeTask", () => {
  it("merges the task branch and leaves the base checked out", () => {
    const wt = openWorktree(repo, worktreePath(home, "demo", "t2"), "agent/ada/t2").path;
    write(wt, "c.txt", "C\n");
    commitAll(wt, "AgentCity Dev", "t2: add c");
    expect(mergeTask(repo, "agent/ada/t2")).toEqual({ ok: true });
    expect(sh(repo, "branch", "--show-current")).toBe("main");
    expect(fs.readFileSync(path.join(repo, "c.txt"), "utf8").trim()).toBe("C");
  });

  it("returns ok false on a conflict and leaves the root clean on the base", () => {
    const wt = openWorktree(repo, worktreePath(home, "demo", "t3"), "agent/ada/t3").path;
    write(wt, "readme.md", "one\n");
    commitAll(wt, "AgentCity Dev", "t3: one");
    write(repo, "readme.md", "two\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "two");
    const r = mergeTask(repo, "agent/ada/t3");
    expect(r.ok).toBe(false);
    expect(sh(repo, "status", "--porcelain")).toBe("");
    expect(sh(repo, "branch", "--show-current")).toBe("main");
    expect(fs.readFileSync(path.join(repo, "readme.md"), "utf8").trim()).toBe("two");
  });

  it("returns ok false with the detail when the root has uncommitted changes", () => {
    const wt = openWorktree(repo, worktreePath(home, "demo", "t2"), "agent/ada/t2").path;
    write(wt, "c.txt", "C\n");
    commitAll(wt, "AgentCity Dev", "t2: add c");
    write(repo, "dirty.txt", "x\n");
    const r = mergeTask(repo, "agent/ada/t2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("uncommitted");
    expect(sh(repo, "branch", "--show-current")).toBe("main");
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(false);
  });
});

describe("headSha, commitExists and resetTo", () => {
  it("resetTo returns a worktree to a commit and removes new untracked files", () => {
    write(repo, "a.txt", "original\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "a");
    const sha = headSha(repo);
    write(repo, "a.txt", "changed\n");
    write(repo, "b.txt", "B\n");
    sh(repo, "add", "a.txt");
    sh(repo, "commit", "-q", "-m", "c");
    write(repo, "c.txt", "C\n");
    sh(repo, "add", "c.txt");
    sh(repo, "commit", "-q", "-m", "c2");
    resetTo(repo, sha);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8").trim()).toBe("original");
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(false);
    expect(headSha(repo)).toBe(sha);
  });

  it("resetTo keeps untracked files that match protected paths", () => {
    const sha = headSha(repo);
    write(repo, ".env", "KEY=1\n");
    write(repo, "b.txt", "B\n");
    resetTo(repo, sha, [".env*"]);
    expect(fs.existsSync(path.join(repo, ".env"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(false);
  });

  it("commitExists is false for an unknown sha", () => {
    expect(commitExists(repo, headSha(repo))).toBe(true);
    expect(commitExists(repo, "0123456789abcdef0123456789abcdef01234567")).toBe(false);
  });
});

describe("removeWorktree", () => {
  it("removes the folder and keeps the branch", () => {
    const wt = openWorktree(repo, worktreePath(home, "demo", "t2"), "agent/ada/t2").path;
    removeWorktree(repo, wt);
    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists("agent/ada/t2")).toBe(true);
  });
});

describe("removeAgentBranches", () => {
  it("removeAgentBranches keeps non-agent branches and files", () => {
    const wt = openWorktree(repo, worktreePath(home, "demo", "t1"), "agent/a").path;
    openWorktree(repo, worktreePath(home, "demo", "t2"), "agent/b/t2");
    sh(repo, "branch", "feature/x");
    // a second project's work in the same repo
    openWorktree(repo, worktreePath(home, "other", "t9"), "agent/c/t9");
    sh(repo, "branch", "agent/d");
    const r = removeAgentBranches(repo, ["agent/a", "agent/b/t2", "agent/gone"]);
    expect([r.removed.sort(), r.failed]).toEqual([["agent/a", "agent/b/t2"], []]);
    expect(branchExists("agent/c/t9")).toBe(true);
    expect(branchExists("agent/d")).toBe(true);
    expect(fs.existsSync(worktreePath(home, "other", "t9"))).toBe(true);
    expect(branchExists("agent/a")).toBe(false);
    expect(branchExists("agent/b/t2")).toBe(false);
    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists("feature/x")).toBe(true);
    expect(branchExists("main")).toBe(true);
    expect(fs.readFileSync(path.join(repo, "readme.md"), "utf8")).toBe("hi\n");
  });

  it("returns empty lists when nothing is named", () => {
    expect(removeAgentBranches(repo, [])).toEqual({ removed: [], failed: [] });
  });
});

describe("testCommand", () => {
  it("uses the configured command, else npm test when package.json has a test script, else none", () => {
    write(repo, "package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    expect(testCommand(repo)).toBe("npm test");
    expect(testCommand(repo, "pnpm t")).toBe("pnpm t");
    write(repo, "package.json", JSON.stringify({ scripts: { build: "tsc" } }));
    expect(testCommand(repo)).toBeUndefined();
  });
});

describe("runTests", () => {
  it("reports pass false for a failing command and pass true for a passing one", async () => {
    expect(await runTests(repo, 'node -e "process.exit(1)"')).toMatchObject({ pass: false });
    expect(await runTests(repo, 'node -e "process.exit(0)"')).toMatchObject({ pass: true });
  });

  it("keeps only the last 4096 bytes of output", async () => {
    const r = await runTests(repo, `node -e "process.stdout.write('a'.repeat(10000)+'END')"`);
    expect(r.pass).toBe(true);
    expect(r.output.length).toBe(4096);
    expect(r.output.endsWith("END")).toBe(true);
  });

  it("kills a command that runs past the timeout and reports timed out", async () => {
    const r = await runTests(repo, `node -e "setTimeout(()=>{},60000)"`, 500);
    expect(r.pass).toBe(false);
    expect(r.output).toContain("timed out");
  }, 20_000);
});
