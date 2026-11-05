import { describe, it, expect } from "vitest";
import { buildSystemPrompt, LEAD_DROPS, WORKER_RULES, type AgentProfile } from "../src/index.js";

const profile: AgentProfile = {
  id: "ada", name: "Ada", role: "worker", persona: "You are Ada.", model: "m", building: "software",
  version: 1, skills: [], createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.000Z",
};

describe("buildSystemPrompt", () => {
  it("starts with the persona and lists tools", () => {
    const out = buildSystemPrompt(profile, { id: "p1", allowedTools: ["read_file", "write_file"] });
    expect(out).toBe(
      `You are Ada.\n\nProject: p1.\nYou may only write files inside the project sandbox.\nTools you may use: read_file, write_file.\n${WORKER_RULES}`,
    );
  });
});

describe("buildSystemPrompt extras", () => {
  const project = { id: "p1", allowedTools: ["read_file"] };
  const base = buildSystemPrompt(profile, project);

  it("no extra gives the part 1 prompt unchanged", () => {
    expect(buildSystemPrompt(profile, project, {})).toBe(base);
    expect(buildSystemPrompt(profile, project, { notes: "" })).toBe(base);
  });
  it("notes block ends the prompt", () => {
    expect(buildSystemPrompt(profile, project, { notes: "- a note" }).endsWith("\n\nYour notes:\n- a note")).toBe(true);
  });
  it("empty notes omit the block", () => {
    expect(buildSystemPrompt(profile, project, { notes: "" })).not.toContain("Your notes:");
    expect(buildSystemPrompt(profile, project, { notes: "n" })).toBe(`${base}\n\nYour notes:\nn`);
  });
});

describe("LEAD_DROPS", () => {
  it("names the tools that change files or run commands", () => {
    expect([...LEAD_DROPS].sort()).toEqual(["delete_file", "edit_file", "run_command", "write_file"]);
  });
});
