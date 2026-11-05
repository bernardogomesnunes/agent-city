import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultProjectConfig, projectDirs, saveProjectConfig } from "@agentcity/safety";
import { openWorktree, removedText, removeProjectFiles, worktreePath } from "../src/worktrees.js";

// Fails the git commands whose arguments start with `failing`, passes the rest to real git.
const fake = vi.hoisted(() => ({ failing: [] as string[] }));
vi.mock("../src/workspace.js", async (orig) => {
  const m = await orig<typeof import("../src/workspace.js")>();
  return {
    ...m,
    git: (dir: string, args: string[]) => {
      if (fake.failing.some((f) => args.join(" ").startsWith(f))) throw new Error("git failed");
      return m.git(dir, args);
    },
  };
});

let home: string;
let repo: string;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const link = (workspace: string) => saveProjectConfig(home, { ...defaultProjectConfig("demo"), workspace });

beforeEach(() => {
  fake.failing = [];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-rm-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-rm-repo-"));
  sh(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "readme.md"), "hi\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("removeProjectFiles", () => {
  it("a git failure marks only the branches that could not be removed", () => {
    link(repo);
    openWorktree(repo, worktreePath(home, "demo", "t2"), "agent/b");
    sh(repo, "branch", "agent/a");
    fake.failing = ["worktree list", "worktree prune"];
    const r = removeProjectFiles(home, "demo", ["agent/a", "agent/b"]);
    // agent/b stays checked out in its worktree, so only it fails
    expect(r.failed).toEqual(["agent/b"]);
    expect(() => sh(repo, "rev-parse", "--verify", "--quiet", "refs/heads/agent/a")).toThrow();
    expect(fs.existsSync(projectDirs(home, "demo").root)).toBe(false);
  });

  it("a linked folder that is gone reports folder missing, branches skipped", () => {
    link(path.join(os.tmpdir(), "ac-rm-no-such-folder"));
    const r = removeProjectFiles(home, "demo", ["agent/a"]);
    expect(r).toEqual({ failed: [], note: "folder missing, branches skipped" });
    expect(removedText("demo", r)).toBe("Removed project demo\nfolder missing, branches skipped");
  });

  it("the answer lists the branches git could not remove", () => {
    expect(removedText("demo", { failed: ["agent/a", "agent/b"] })).toBe("Removed project demo\ncould not remove: agent/a, agent/b");
    expect(removedText("demo", { failed: [] })).toBe("Removed project demo");
  });
});
