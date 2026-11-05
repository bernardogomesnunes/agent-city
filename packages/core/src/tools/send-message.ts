import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Tool } from "./types.js";

export const sendMessageTool: Tool<{ to: string; body: string }> = {
  name: "send_message",
  description: "Queue an outgoing message in the outbox. Nothing is sent until a human releases it.",
  tier: 2,
  schema: z.object({ to: z.string(), body: z.string() }),
  async run(args, ctx) {
    await fs.mkdir(ctx.outboxDir, { recursive: true });
    const name = `${Date.now()}-${randomBytes(2).toString("hex")}.json`;
    await fs.writeFile(path.join(ctx.outboxDir, name), JSON.stringify({ to: args.to, body: args.body }), "utf8");
    return `queued: ${name}`;
  },
};
