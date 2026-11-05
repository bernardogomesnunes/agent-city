import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInSandbox } from "./sandbox.js";
import type { Tool } from "./types.js";

const unescape = (s: string): string => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");

/** Where whole lines of `text` equal the lines of `old` once each line is trimmed. Offsets cover those lines without the last line break. */
function byTrimmedLines(text: string, old: string): Array<{ start: number; end: number }> {
  const want = old.split("\n").map((l) => l.trim());
  while (want.length > 0 && want[0] === "") want.shift();
  while (want.length > 0 && want[want.length - 1] === "") want.pop();
  if (want.length === 0) return [];
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i].length + 1, i++) starts.push(at);
  const found: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => lines[i + k].trim() === w)) {
      const last = i + want.length - 1;
      found.push({ start: starts[i], end: starts[last] + lines[last].replace(/\r$/, "").length });
    }
  }
  return found;
}

export const editFileTool: Tool<{ path: string; old: string; new: string; replaceAll?: boolean }> = {
  name: "edit_file",
  description: "Replace exact text in a file. `old` must appear exactly once unless replaceAll is true. Read the file first.",
  tier: 1,
  schema: z.object({
    path: z.string().describe("Path relative to the project folder"),
    old: z.string().min(1).describe("Exact text to replace, including spaces and line breaks"),
    new: z.string().describe("Replacement text"),
    replaceAll: z.boolean().optional(),
  }),
  async run(args, ctx) {
    const full = await resolveInSandbox(ctx.sandboxDir, args.path);
    const text = await fs.readFile(full, "utf8");
    let { old, new: next } = args;
    let parts = text.split(old);
    // Some local models send line breaks as the two characters \n. Retry with them decoded.
    if (parts.length === 1 && /\\[nt]/.test(old)) {
      old = unescape(old);
      next = unescape(next);
      parts = text.split(old);
    }
    if (parts.length === 1) {
      const at = byTrimmedLines(text, old);
      if (at.length === 1) parts = [text.slice(0, at[0].start), text.slice(at[0].end)];
    }
    const count = parts.length - 1;
    if (count === 0) throw new Error(`text not found in ${args.path}; read_file it again and copy the exact lines, or write_file the whole file`);
    if (count > 1 && !args.replaceAll) throw new Error(`text found ${count} times in ${args.path}; add more context or set replaceAll`);
    // join replaces literally, so "$&" in the new text stays as typed
    await fs.writeFile(full, parts.join(next), "utf8");
    const rel = path.relative(await fs.realpath(ctx.sandboxDir), full);
    return `edited ${rel} (${count} replacement${count === 1 ? "" : "s"})`;
  },
};
