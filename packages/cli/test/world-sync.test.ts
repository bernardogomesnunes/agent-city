import { describe, it, expect } from "vitest";
import { AgentProfileSchema, makeBuildTool } from "@agentcity/org";
import { PLOT_KINDS, AGENT_BUILDINGS } from "@agentcity/world/shared";

describe("world and org stay in sync", () => {
  it("plot kinds match between org and world", () => {
    const { schema } = makeBuildTool(() => true);
    for (const kind of PLOT_KINDS) expect(schema.safeParse({ plot: 1, kind }).success, kind).toBe(true);
    expect(schema.safeParse({ plot: 1, kind: "castle" }).success).toBe(false);
    expect(PLOT_KINDS).toEqual(["library", "workshop", "exchange", "studio", "house"]);
  });
  it("agent buildings match between org and world", () => {
    const base = {
      id: "ada", name: "Ada", role: "worker", persona: "p", model: "m", version: 1,
      createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.000Z",
    };
    for (const building of AGENT_BUILDINGS) {
      expect(AgentProfileSchema.safeParse({ ...base, building }).success, building).toBe(true);
    }
    expect(AgentProfileSchema.safeParse({ ...base, building: "castle" }).success).toBe(false);
  });
});
