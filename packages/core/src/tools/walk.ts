import fs from "node:fs/promises";
import path from "node:path";

/** Folders the file tools never enter. */
export const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Yields files and folders under root as "/"-separated paths relative to base, sorted by name. Skips links and SKIP_DIRS. */
export async function* walk(base: string, root: string): AsyncGenerator<{ rel: string; dir: boolean }> {
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const entries = await fs.readdir(cur, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(cur, e.name);
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        yield { rel, dir: true };
        dirs.push(full);
      } else if (e.isFile()) yield { rel, dir: false };
    }
    stack.push(...dirs.reverse());
  }
}
