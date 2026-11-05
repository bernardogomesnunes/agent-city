import { describe, expect, it } from "vitest";
import { AgentProfileSchema } from "@agentcity/org";
import { isReservedId } from "@agentcity/safety";

const ids = ["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`), "console"];
const agentAccepts = (id: string) =>
  AgentProfileSchema.safeParse({ id, name: "n", role: "worker", persona: "p", model: "m", version: 1, createdAt: "t", updatedAt: "t" }).success;

describe("reserved id lists", () => {
  it.each(ids)("safety and org agree on %s", (id) => {
    expect(agentAccepts(id)).toBe(!isReservedId(id));
  });
  it("only console is accepted", () => {
    expect(ids.filter(agentAccepts)).toEqual(["console"]);
  });
});
