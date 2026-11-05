import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInSandbox } from "./sandbox.js";
import type { Tool } from "./types.js";

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: "write_file",
  description: "Write a text file inside the project sandbox. Creates parent folders.",
  tier: 1,
  schema: z.object({
    path: z.string().describe("Path relative to the sandbox"),
    content: z.string(),
  }),
  async run(args, ctx) {
    const full = await resolveInSandbox(ctx.sandboxDir, args.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // re-check after creating folders so a racing symlink cannot redirect the write
    const again = await resolveInSandbox(ctx.sandboxDir, args.path);
    await fs.writeFile(again, args.content, "utf8");
    const rel = path.relative(await fs.realpath(ctx.sandboxDir), again);
    return `wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${rel}`;
  },
};
