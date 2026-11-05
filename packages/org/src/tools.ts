import { z } from "zod";
import type { Tool, ToolContext } from "@agentcity/core";
import type { MemoryStore } from "./memory.js";

export function makeRememberTool(
  memory: MemoryStore,
  redactText: (s: string) => string,
): Tool<{ note: string }> {
  return {
    name: "remember",
    description: "Save a short note to your own notes. Notes are shown to you in later runs.",
    tier: 1,
    schema: z.object({ note: z.string().min(1).max(500) }),
    async run(args, ctx) {
      const note = redactText(args.note.replace(/\r?\n/g, " "));
      memory.append(ctx.agentId, `- ${new Date().toISOString()} ${note}`);
      return "remembered";
    },
  };
}

export type PlotKind = "library" | "workshop" | "exchange" | "studio" | "house";
/** Loads an attached skill's instructions. Tier 0. */
export function makeUseSkillTool(load: (name: string) => string | undefined, attached: string[]): Tool<{ name: string }> {
  return {
    name: "use_skill",
    description: `Load the full instructions of one of your skills: ${attached.join(", ")}.`,
    tier: 0,
    schema: z.object({ name: z.string() }),
    async run(args) {
      if (!attached.includes(args.name)) throw new Error(`no skill ${args.name}; yours: ${attached.join(", ")}`);
      const body = load(args.name);
      if (body === undefined) throw new Error(`skill ${args.name} is missing on disk`);
      return body;
    },
  };
}

export type ClaimPlot = (plot: number, kind: PlotKind, ctx: ToolContext) => boolean;

export function makeBuildTool(claim: ClaimPlot): Tool<{ plot: number; kind: PlotKind }> {
  return {
    name: "build",
    description: "Build a house or workplace on one of the six city plots (1 to 6). Fails if the plot is taken.",
    tier: 2,
    schema: z.object({
      plot: z.number().int().min(1).max(6),
      kind: z.enum(["library", "workshop", "exchange", "studio", "house"]),
    }),
    async run(args, ctx) {
      return claim(args.plot, args.kind, ctx) ? `built ${args.kind} on plot ${args.plot}` : `plot ${args.plot} is taken`;
    },
  };
}
