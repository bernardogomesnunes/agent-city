import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInSandbox } from "./sandbox.js";
import type { Tool } from "./types.js";
import { SKIP_DIRS } from "./walk.js";

export const LIST_LIMIT = 300;
/** A folder below the listed one with more entries than this shows as one line. Every line is resent on each later step. */
export const FOLDER_LIMIT = 100;

/** Entries under dir, counted up to limit + 1. Skips links and SKIP_DIRS like the listing does. */
async function countUpTo(dir: string, limit: number): Promise<number> {
  let n = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const e of await fs.readdir(cur, { withFileTypes: true })) {
      if (e.isSymbolicLink() || (e.isDirectory() && SKIP_DIRS.has(e.name))) continue;
      if (++n > limit) return n;
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
    }
  }
  return n;
}

export const listFilesTool: Tool<{ path?: string }> = {
  name: "list_files",
  description:
    `List files and folders (folders end in /) under a folder, recursively. Skips .git and node_modules. ` +
    `A folder with more than ${FOLDER_LIMIT} entries shows as one line; list it by path to see it. At most ${LIST_LIMIT} lines.`,
  tier: 0,
  schema: z.object({ path: z.string().optional().describe("Folder relative to the project folder. Default: the whole folder.") }),
  async run(args, ctx) {
    const base = await fs.realpath(ctx.sandboxDir);
    const root = await resolveInSandbox(ctx.sandboxDir, args.path ?? ".");
    const lines: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const entries = await fs.readdir(cur, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const dirs: string[] = [];
      for (const e of entries) {
        if (lines.length >= LIST_LIMIT) {
          lines.push(`[list cut at ${LIST_LIMIT} lines]`);
          return lines.join("\n");
        }
        if (e.isSymbolicLink()) continue;
        const full = path.join(cur, e.name);
        const rel = path.relative(base, full).split(path.sep).join("/");
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          if ((await countUpTo(full, FOLDER_LIMIT)) > FOLDER_LIMIT) {
            lines.push(`${rel}/ (more than ${FOLDER_LIMIT} entries, not listed. Use list_files with path "${rel}" to see them.)`);
            continue;
          }
          lines.push(`${rel}/`);
          dirs.push(full);
        } else if (e.isFile()) lines.push(rel);
      }
      stack.push(...dirs.reverse());
    }
    return lines.length > 0 ? lines.join("\n") : "(empty)";
  },
};
