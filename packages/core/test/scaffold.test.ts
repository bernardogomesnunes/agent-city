import { describe, it, expect } from "vitest";
import { VERSION } from "@agentcity/core";

describe("scaffold", () => {
  it("core exports a version", () => expect(VERSION).toBe("0.1.0"));
});
