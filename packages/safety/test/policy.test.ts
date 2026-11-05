import { describe, expect, it } from "vitest";
import { DEFAULT_SAFE_COMMANDS, ProjectConfigSchema, defaultProjectConfig, effectiveTier, isProtected, isSafeCommand } from "../src/index.js";

const policy = defaultProjectConfig("demo");

describe("isProtected", () => {
  it.each([
    [".env", true], ["config/.env.production", true], [".git/HEAD", true], [".git", true],
    [".github/workflows/ci.yml", true], ["src/app.ts", false], ["../outside.txt", true], ["C:\\x.txt", true],
  ])("%s is %s", (p, want) => {
    expect(isProtected(policy, p)).toBe(want);
  });
  it("uses the project's own patterns", () => {
    expect(isProtected({ protectedPaths: ["package.json", "infra/**"] }, "infra/main.tf")).toBe(true);
    expect(isProtected({ protectedPaths: [] }, ".env")).toBe(false);
  });
});

describe("isSafeCommand", () => {
  it.each([
    ["npm test", true], ["npm  test   -- --run", true], ["git commit -m \"fix: a\"", true], ["git status", true],
    ["npm testx", false], ["npm install", false], ["rm -rf /", false],
    ["npm test && rm -rf /", false], ["git status; curl x", false], ["git log > out.txt", false],
    ["git commit -m \"$(whoami)\"", false], ["echo %PATH%", false], ["git push", false],
  ])("%s is %s", (c, want) => {
    expect(isSafeCommand(policy, c)).toBe(want);
  });
  it("never treats git push as safe, even when listed", () => {
    expect(isSafeCommand({ safeCommands: ["git push"] }, "git push origin main")).toBe(false);
  });
});

describe("effectiveTier", () => {
  it("edits keep their tier on auto and ask on ask, protected paths or --ask-edits", () => {
    expect(effectiveTier(policy, "edit_file", { path: "src/a.ts" }, 1)).toBe(1);
    expect(effectiveTier({ ...policy, edits: "ask" }, "write_file", { path: "src/a.ts" }, 1)).toBe(2);
    expect(effectiveTier(policy, "write_file", { path: ".env" }, 1)).toBe(2);
    expect(effectiveTier(policy, "edit_file", { path: "src/a.ts" }, 1, true)).toBe(2);
  });
  it("run_command drops to tier 1 only for a safe command", () => {
    expect(effectiveTier(policy, "run_command", { command: "npm test" }, 2)).toBe(1);
    expect(effectiveTier(policy, "run_command", { command: "npm install" }, 2)).toBe(2);
  });
  it("other tools keep their tier", () => {
    expect(effectiveTier({ ...policy, edits: "ask" }, "read_file", { path: "a" }, 0)).toBe(0);
    expect(effectiveTier(policy, "delete_file", { path: "a" }, 2)).toBe(2);
  });
});

describe("config defaults", () => {
  it("an old project.json without the new fields gets the defaults", () => {
    const old: Record<string, unknown> = { ...defaultProjectConfig("demo") };
    delete old.edits;
    delete old.protectedPaths;
    delete old.safeCommands;
    const parsed = ProjectConfigSchema.parse(old);
    expect(parsed.edits).toBe("auto");
    expect(parsed.protectedPaths).toEqual([".env*", ".git/**", ".github/**"]);
    expect(parsed.safeCommands).toEqual([...DEFAULT_SAFE_COMMANDS]);
    expect(parsed.workspace).toBeUndefined();
  });
});
