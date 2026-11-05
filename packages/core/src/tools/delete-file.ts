import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInSandbox } from "./sandbox.js";
import type { Tool } from "./types.js";

export const deleteFileTool: Tool<{ path: string }> = {
  name: "delete_file",
  description: "Delete one file. Always asks the user first. Does not delete folders.",
  tier: 2,
  schema: z.object({ path: z.string().describe("Path relative to the project folder") }),
  async run(args, ctx) {
    const full = await resolveInSandbox(ctx.sandboxDir, args.path);
    if (!(await fs.lstat(full)).isFile()) throw new Error(`not a file: ${args.path}`);
    await fs.unlink(full);
    return `deleted ${path.relative(await fs.realpath(ctx.sandboxDir), full)}`;
  },
};
