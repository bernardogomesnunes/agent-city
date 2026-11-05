import { describe, it, expect } from "vitest";
import { canDelegate, type AgentRole } from "../src/index.js";

describe("canDelegate", () => {
  const roles: AgentRole[] = ["boss", "manager", "worker"];
  const allowed = new Set(["boss>manager", "boss>worker", "manager>worker"]);
  for (const from of roles) for (const to of roles) {
    it(`${from}->${to} is ${allowed.has(`${from}>${to}`)}`, () => {
      expect(canDelegate(from, to)).toBe(allowed.has(`${from}>${to}`));
    });
  }
});
