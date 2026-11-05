import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isProtected, loadProjectConfig, projectDirs } from "@agentcity/safety";
import { baseBranch, branchExists, git, isGitRepo, mergeAgentBranch } from "./workspace.js";

const AGENT_EMAIL = "agents@agentcity.local";
const TAIL_BYTES = 4096;
const TEST_TIMEOUT_MS = 300_000;

/** Makes root a git repo with one empty commit when root has no .git. */
export function ensureRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(path.join(root, ".git"))) return;
  git(root, ["init", "-q"]);
  // Files already in the folder go in the first commit: worktrees are cut from it.
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=AgentCity", "-c", `user.email=${AGENT_EMAIL}`, "commit", "-q", "--allow-empty", "-m", "init"]);
}

/** The worktree folder of one task: <home>/worktrees/<project>/<taskId>. */
export function worktreePath(home: string, project: string, taskId: string): string {
  return path.join(home, "worktrees", project, taskId);
}

/**
 * Opens a worktree at wtPath on branch. Reuses a worktree already at wtPath.
 * A new branch is cut from the base branch. An existing branch keeps its commits.
 */
export function openWorktree(root: string, wtPath: string, branch: string): { path: string; branch: string; base: string } {
  const base = baseBranch(root);
  // a .git file marks a worktree; isGitRepo would also say yes for a plain folder inside another repo
  if (!fs.existsSync(path.join(wtPath, ".git"))) {
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    git(root, branchExists(root, branch) ? ["worktree", "add", wtPath, branch] : ["worktree", "add", "-b", branch, wtPath, base]);
  }
  return { path: wtPath, branch, base };
}

/** Stages every change in dir except protected paths and commits it as author. Commits nothing when there are no changes. */
export function commitAll(dir: string, author: string, message: string, protectedPaths: string[] = []): { committed: boolean; files: number } {
  git(dir, ["add", "-A"]);
  const staged = () => git(dir, ["diff", "--cached", "--name-only"]).split(/\r?\n/).filter((n) => n !== "");
  const kept = staged().filter((n) => isProtected({ protectedPaths }, n));
  if (kept.length > 0) git(dir, ["reset", "-q", "--", ...kept]);
  const files = staged().length;
  if (files === 0) return { committed: false, files: 0 };
  git(dir, ["-c", `user.name=${author}`, "-c", `user.email=${AGENT_EMAIL}`, "commit", "-q", "-m", message]);
  return { committed: true, files };
}

/** Files that differ from base: committed, staged, changed or untracked. */
export function changedFiles(dir: string, base: string): number {
  const names = new Set([
    ...git(dir, ["diff", "--name-only", base]).split(/\r?\n/),
    ...git(dir, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/),
  ]);
  names.delete("");
  return names.size;
}

/** Merges a task branch (agent/<agent>/<task>) into the base in root. */
export function mergeTask(root: string, branch: string): { ok: true } | { ok: false; detail: string } {
  const r = mergeAgentBranch(root, branch);
  return r.ok ? { ok: true } : { ok: false, detail: r.detail };
}

/** Removes the worktree folder. The branch stays. */
export function removeWorktree(root: string, wtPath: string): void {
  if (fs.existsSync(wtPath)) git(root, ["worktree", "remove", "--force", wtPath]);
  git(root, ["worktree", "prune"]);
}

/** The commit HEAD points to in dir. */
export function headSha(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/** True when sha names a commit that exists in dir. */
export function commitExists(dir: string, sha: string): boolean {
  try {
    git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the worktrees and local branches named in branches from repo. Other branches, other agent/* branches and the files stay.
 * Keeps going after a failure. Names that no longer exist are skipped.
 */
export function removeAgentBranches(repo: string, branches: string[]): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  const wanted = new Set(branches.filter((b) => b.startsWith("agent/")));
  // Porcelain lists "worktree <path>" then "branch refs/heads/<name>" per worktree. The first block is the main one.
  // A git failure here only leaves the worktrees in place: their branches then fail one by one below.
  let listing = "";
  try {
    listing = git(repo, ["worktree", "list", "--porcelain"]);
  } catch {
    listing = "";
  }
  for (const block of listing.split(/\r?\n\r?\n/).slice(1)) {
    const wtPath = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (!wtPath || !branch || !wanted.has(branch.trim())) continue;
    try {
      git(repo, ["worktree", "remove", "--force", wtPath.trim()]);
    } catch {
      failed.push(branch.trim());
      wanted.delete(branch.trim());
    }
  }
  try {
    git(repo, ["worktree", "prune"]);
  } catch {
    // A branch still held by a worktree fails its own delete below.
  }
  for (const name of wanted) {
    if (!branchExists(repo, name)) continue;
    try {
      git(repo, ["branch", "-D", name]);
      removed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed };
}

/** Hard-resets dir to sha and removes untracked files, except untracked ones matching protectedPaths. Tracked files go back to sha even when protected. Changes made after sha are lost. */
export function resetTo(dir: string, sha: string, protectedPaths: string[] = []): void {
  git(dir, ["reset", "--hard", sha]);
  git(dir, ["clean", "-fd", ...protectedPaths.flatMap((p) => ["-e", p])]);
}

/** The test command: configured, else `npm test` when package.json has a test script, else undefined. */
export function testCommand(dir: string, configured?: string): string | undefined {
  const own = configured?.trim();
  if (own) return own;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: { test?: unknown } };
    const script = pkg.scripts?.test;
    return typeof script === "string" && script.trim() !== "" ? "npm test" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs command through the platform shell in dir. Pass when it exits 0.
 * Output keeps the last 4096 bytes. A command past timeoutMs is killed and fails.
 */
export function runTests(dir: string, command: string, timeoutMs = TEST_TIMEOUT_MS): Promise<{ pass: boolean; output: string }> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    const add = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    // On Unix the shell leads its own process group, so a kill takes its children too.
    const child = spawn(command, { cwd: dir, shell: true, windowsHide: true, detached: process.platform !== "win32" });
    let settled = false;
    const finish = (pass: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pass, output: tail.toString("utf8") });
    };
    const timer = setTimeout(() => {
      add(Buffer.from(`\nTests timed out after ${timeoutMs} ms.`));
      killTree(child);
      finish(false);
    }, timeoutMs);
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (e) => {
      add(Buffer.from(`\n${e.message}`));
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Kills the shell and its children. On Windows, taskkill takes the whole tree, synchronously, so no child keeps dir open.
 * On Unix a negative pid signals the shell's process group.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * Removes the branches (the project's task branches) and worktrees from a linked git folder, then deletes the project's folders under home.
 * The linked folder itself and its files stay. Returns the branches git could not remove, and a note when the linked folder is gone.
 * A file error throws, before anything else is deleted.
 */
export function removeProjectFiles(home: string, projectId: string, branches: string[]): RemovedFiles {
  const dirs = projectDirs(home, projectId);
  const loaded = loadProjectConfig(home, projectId);
  const linked = loaded.ok ? loaded.config.workspace : undefined;
  let failed: string[] = [];
  let note: string | undefined;
  if (linked && !fs.existsSync(linked)) note = "folder missing, branches skipped";
  else if (linked && isGitRepo(linked)) failed = removeAgentBranches(linked, branches).failed;
  fs.rmSync(path.join(home, "worktrees", projectId), { recursive: true, force: true });
  fs.rmSync(dirs.root, { recursive: true, force: true });
  return { failed, ...(note ? { note } : {}) };
}

export interface RemovedFiles {
  /** Branches git could not remove. */
  failed: string[];
  /** Set when the linked folder is gone, so its branches were skipped. */
  note?: string;
}

/** The answer to a project remove: the plain line, the folder note, and the branches git could not remove. */
export function removedText(projectId: string, r: RemovedFiles): string {
  return [`Removed project ${projectId}`, ...(r.note ? [r.note] : []), ...(r.failed.length > 0 ? [`could not remove: ${r.failed.join(", ")}`] : [])].join("\n");
}
