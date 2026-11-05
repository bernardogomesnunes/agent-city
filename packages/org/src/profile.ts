import { z } from "zod";

export type AgentRole = "boss" | "manager" | "worker";
export type AgentBuilding = "software" | "visual";

export interface AgentProfile {
  id: string;
  name: string;
  role: AgentRole;
  persona: string;
  model: string;
  building: AgentBuilding;
  /** Skill names the agent may load with use_skill. */
  skills: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentInput = Pick<AgentProfile, "id" | "name" | "role" | "persona" | "model"> & { building?: AgentBuilding; skills?: string[] };

export const AGENT_ID = /^[a-z0-9-]{1,32}$/;

// Same list as isReservedId in @agentcity/safety (org may not import safety).
const RESERVED_IDS = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

export const AgentProfileSchema: z.ZodType<AgentProfile, unknown> = z.object({
  id: z.string().regex(AGENT_ID).refine((v) => !RESERVED_IDS.has(v), "reserved id"),
  name: z.string().trim().min(1),
  role: z.enum(["boss", "manager", "worker"]),
  persona: z.string().min(1).max(8000),
  model: z.string().min(1),
  building: z.enum(["software", "visual"]).default("software"),
  skills: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).default([]),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
