import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { projectDirs, type ProjectConfig } from "@agentcity/safety";

/** Runs git in dir and returns stdout. Throws on a non-zero exit. */
export const git = (dir: string, args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

/** The folder tools work in: the linked folder, or the project sandbox. */
export function workDir(home: string, config: ProjectConfig | undefined, project: string): string {
  return config?.workspace ?? projectDirs(home, project).sandbox;
}

/** True when dir is inside a git work tree. False when git is missing. */
export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/** Lines of `git status --porcelain`: one per changed or untracked file. */
export function gitChanges(dir: string): string[] {
  return git(dir, ["status", "--porcelain"]).split(/\r?\n/).filter((l) => l !== "");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** agent/<agent>-YYYYMMDD-HHMMSS in local time. */
export function branchName(agentId: string, now = new Date()): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `agent/${agentId}-${d}-${t}`;
}

export function branchExists(dir: string, name: string): boolean {
  try {
    git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** Creates and checks out a new branch from the current commit. */
export function startBranch(dir: string, name: string): void {
  git(dir, ["switch", "-c", name]);
}

/** Resolves a user-given folder to an absolute real path. Throws when it is not an existing folder. */
export function resolveFolder(folder: string): string {
  const abs = path.resolve(folder);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`No folder at ${abs}.`);
  }
  if (!st.isDirectory()) throw new Error(`${abs} is not a folder.`);
  return fs.realpathSync(abs);
}

/**
 * Prepares a linked git folder for a top run: refuses uncommitted changes, then switches to a new branch.
 * Returns the branch, or undefined for a sandbox or a folder without git.
 */
export function prepareWorkspace(config: ProjectConfig | undefined, agentId: string): { ok: true; branch?: string } | { ok: false; reason: string; detail: string } {
  const ws = config?.workspace;
  if (!ws || !isGitRepo(ws)) return { ok: true };
  try {
    const changes = gitChanges(ws);
    if (changes.length > 0) {
      return {
        ok: false,
        reason: "workspace_dirty",
        detail: `${ws} has ${changes.length} uncommitted change${changes.length === 1 ? "" : "s"}. Commit or stash them, then run again.`,
      };
    }
    // two runs in the same second would pick the same name
    const base = branchName(agentId);
    let branch = base;
    for (let n = 2; branchExists(ws, branch); n++) branch = `${base}-${n}`;
    startBranch(ws, branch);
    return { ok: true, branch };
  } catch (e) {
    const msg = e instanceof Error ? ((e as { stderr?: string }).stderr || e.message) : String(e);
    return { ok: false, reason: "workspace_git", detail: `git failed in ${ws}: ${msg.trim()}` };
  }
}

/** The branch agent work merges into: main, else master, else the branch checked out now. */
export function baseBranch(dir: string): string {
  for (const b of ["main", "master"]) if (branchExists(dir, b)) return b;
  return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

export interface AgentBranch {
  name: string;
  /** Commits on the branch that the base lacks. */
  ahead: number;
  subject: string;
  date: string;
  /** `git diff --shortstat` against the base, e.g. "3 files changed, 40 insertions(+)". */
  stat: string;
}

/** agent/* branches with commits the base branch does not have yet, newest first. */
export function agentBranches(dir: string, base = baseBranch(dir)): AgentBranch[] {
  const lines = git(dir, [
    "for-each-ref", "--sort=-committerdate", "--no-merged", base,
    "--format=%(refname:short)%09%(committerdate:iso-strict)%09%(subject)", "refs/heads/agent/",
  ]).split(/\r?\n/).filter((l) => l !== "");
  return lines.map((l) => {
    const [name, date, ...subject] = l.split("\t");
    return {
      name: name!,
      date: date ?? "",
      subject: subject.join("\t"),
      ahead: Number(git(dir, ["rev-list", "--count", `${base}..${name}`]).trim()),
      stat: git(dir, ["diff", "--shortstat", `${base}...${name}`]).trim(),
    };
  });
}

/**
 * Merges an agent branch into the base branch with a merge commit and leaves the base checked out.
 * Refuses uncommitted changes. A conflict aborts the merge and puts the repo back as it was.
 */
export function mergeAgentBranch(dir: string, branch: string): { ok: true; base: string } | { ok: false; detail: string } {
  if (!/^agent\/[A-Za-z0-9._/-]+$/.test(branch) || !branchExists(dir, branch)) return { ok: false, detail: `No agent branch ${branch}.` };
  const changes = gitChanges(dir);
  if (changes.length > 0) return { ok: false, detail: `${dir} has ${changes.length} uncommitted change(s). Commit or stash them first.` };
  const base = baseBranch(dir);
  const before = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  git(dir, ["switch", base]);
  try {
    git(dir, ["merge", "--no-ff", "--no-edit", branch]);
    return { ok: true, base };
  } catch (e) {
    try {
      git(dir, ["merge", "--abort"]);
    } catch {
      // nothing to abort
    }
    if (before !== base) git(dir, ["switch", before]);
    const msg = e instanceof Error ? ((e as { stdout?: string }).stdout || (e as { stderr?: string }).stderr || e.message) : String(e);
    return { ok: false, detail: `Merging ${branch} into ${base} failed, nothing changed: ${msg.trim()}` };
  }
}
