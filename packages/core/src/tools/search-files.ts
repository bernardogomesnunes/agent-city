import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { globToRegExp } from "./glob.js";
import { resolveInSandbox } from "./sandbox.js";
import type { Tool } from "./types.js";
import { walk } from "./walk.js";

export const SEARCH_LIMIT = 200;
const MAX_FILE_BYTES = 1_000_000;
const LINE_CHARS = 200;

export const searchFilesTool: Tool<{ pattern: string; path?: string; glob?: string }> = {
  name: "search_files",
  description: `Search text files for a regular expression. Returns file:line: text, at most ${SEARCH_LIMIT} matches. Skips .git, node_modules, binary files and files over 1 MB.`,
  tier: 0,
  schema: z.object({
    pattern: z.string().min(1).describe("JavaScript regular expression"),
    path: z.string().optional().describe("Folder relative to the project folder. Default: the whole folder."),
    glob: z.string().optional().describe('Only files matching this glob, e.g. "*.ts" or "src/**/*.css"'),
  }),
  async run(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch (e) {
      throw new Error(`invalid pattern: ${(e as Error).message}`);
    }
    const only = args.glob ? globToRegExp(args.glob) : undefined;
    const base = await fs.realpath(ctx.sandboxDir);
    const root = await resolveInSandbox(ctx.sandboxDir, args.path ?? ".");
    const hits: string[] = [];
    for await (const e of walk(base, root)) {
      if (e.dir || (only && !only.test(e.rel))) continue;
      const full = path.join(base, e.rel);
      if ((await fs.stat(full)).size > MAX_FILE_BYTES) continue;
      const buf = await fs.readFile(full);
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!)) continue;
        hits.push(`${e.rel}:${i + 1}: ${lines[i]!.trim().slice(0, LINE_CHARS)}`);
        if (hits.length >= SEARCH_LIMIT) return hits.join("\n") + `\n[search cut at ${SEARCH_LIMIT} matches]`;
      }
    }
    return hits.length > 0 ? hits.join("\n") : "no matches";
  },
};
