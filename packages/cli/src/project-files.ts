import fs from "node:fs";
import path from "node:path";
import { resolveInSandbox } from "@agentcity/core";
import { isProtected } from "@agentcity/safety";
import type { FileTree } from "@agentcity/world/shared";

/** The most bytes of one file the client gets. */
export const FILE_MAX = 200 * 1024;
/** The most entries of one tree. */
export const TREE_MAX = 500;
const BINARY_SCAN = 8 * 1024;
const SKIP = new Set([".git", "node_modules"]);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Resolves rel under root and checks the protected list on both the asked path and the real one.
 * A link named index.html that points at .env is refused like .env itself. Undefined when protected.
 */
export async function resolveUnprotected(root: string, rel: string, protectedPaths: string[]): Promise<string | undefined> {
  if (isProtected({ protectedPaths }, rel)) return undefined;
  const abs = await resolveInSandbox(root, rel);
  const real = path.relative(await fs.promises.realpath(root), abs).split(path.sep).join("/");
  return isProtected({ protectedPaths }, real) ? undefined : abs;
}

/** A sorted tree of the files under `root`, breadth first. Links are not followed. Protected paths stay hidden. */
export async function listFiles(root: string, protectedPaths: string[]): Promise<FileTree> {
  try {
    if (!(await fs.promises.stat(root)).isDirectory()) return { entries: [], truncated: false, error: "folder not found" };
  } catch {
    return { entries: [], truncated: false, error: "folder not found" };
  }
  const entries: FileTree["entries"] = [];
  const policy = { protectedPaths };
  let truncated = false;
  const queue: string[] = [""];
  while (queue.length > 0 && !truncated) {
    const dir = queue.shift()!;
    let items: fs.Dirent[];
    try {
      items = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (SKIP.has(item.name) || item.isSymbolicLink()) continue;
      const rel = dir === "" ? item.name : `${dir}/${item.name}`;
      if (isProtected(policy, rel)) continue;
      if (entries.length >= TREE_MAX) {
        truncated = true;
        break;
      }
      if (item.isDirectory()) {
        entries.push({ path: rel, size: 0, dir: true });
        queue.push(rel);
      } else if (item.isFile()) {
        let size = 0;
        try {
          size = (await fs.promises.stat(path.join(root, rel))).size;
        } catch {
          // a file that vanished while listing keeps size 0
        }
        entries.push({ path: rel, size, dir: false });
      }
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated };
}

export interface ProjectFile { text?: string; binary: boolean; truncated: boolean; error?: string }

/** Reads one file under `root`: at most 200 KB, binary when a NUL byte is in the first 8 KB. Errors come back as `error`. */
export async function readProjectFile(root: string, rel: string, protectedPaths: string[]): Promise<ProjectFile> {
  const fail = (error: string): ProjectFile => ({ binary: false, truncated: false, error });
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) return fail("invalid path");
  let abs: string | undefined;
  try {
    abs = await resolveUnprotected(root, rel, protectedPaths);
  } catch (e) {
    return fail(messageOf(e));
  }
  if (abs === undefined) return fail("protected path");
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(abs, "r");
    const st = await handle.stat();
    if (!st.isFile()) return fail("not a file");
    const buf = Buffer.alloc(Math.min(st.size, FILE_MAX));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.subarray(0, BINARY_SCAN).includes(0)) return { binary: true, truncated: false };
    return { text: data.toString("utf8"), binary: false, truncated: st.size > FILE_MAX };
  } catch (e) {
    return fail(messageOf(e));
  } finally {
    await handle?.close();
  }
}
