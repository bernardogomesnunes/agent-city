import fs from "node:fs/promises";
import { z } from "zod";
import { resolveInSandbox } from "./sandbox.js";
import type { Tool } from "./types.js";

export const READ_LIMIT = 60_000;

export const readFileTool: Tool<{ path: string }> = {
  name: "read_file",
  description: "Read a text file inside the project sandbox. Output is cut at 60000 characters.",
  tier: 0,
  schema: z.object({ path: z.string().describe("Path relative to the sandbox") }),
  async run(args, ctx) {
    const full = await resolveInSandbox(ctx.sandboxDir, args.path);
    const text = await fs.readFile(full, "utf8");
    if (text.length <= READ_LIMIT) return text;
    return text.slice(0, READ_LIMIT) + `\n[file cut at ${READ_LIMIT} characters]`;
  },
};
