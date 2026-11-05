import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "@agentcity/core";
import { MemoryStore, makeRememberTool, makeBuildTool } from "../src/index.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "tools-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const ctx = (agentId: string): ToolContext => ({ projectId: "p", agentId, sandboxDir: "/s", outboxDir: "/o", runId: "r1", depth: 1 });

describe("remember", () => {
  it("writes a dated line to the caller's notes only", async () => {
    const mem = new MemoryStore(home);
    const tool = makeRememberTool(mem, (s) => s);
    expect(tool.name).toBe("remember");
    expect(tool.tier).toBe(1);
    expect(await tool.run({ note: "likes tea" }, ctx("ada"))).toBe("remembered");
    expect(mem.read("ada")).toMatch(/^- \d{4}-\d\d-\d\dT[\d:.]+Z likes tea$/);
    expect(mem.read("bob")).toBe("");
  });
  it("replaces newlines and redacts", async () => {
    const mem = new MemoryStore(home);
    const tool = makeRememberTool(mem, (s) => s.replace(/sk-\w+/g, "[redacted]"));
    await tool.run({ note: "key sk-abc\nnext\r\nline" }, ctx("ada"));
    const text = mem.read("ada");
    expect(text).toContain("key [redacted] next line");
    expect(text.trimEnd().split("\n")).toHaveLength(1);
  });
  it("rejects a 501-char note via schema", () => {
    const tool = makeRememberTool(new MemoryStore(home), (s) => s);
    expect(tool.schema.safeParse({ note: "x".repeat(501) }).success).toBe(false);
    expect(tool.schema.safeParse({ note: "x".repeat(500) }).success).toBe(true);
    expect(tool.schema.safeParse({ note: "" }).success).toBe(false);
  });
});

describe("build", () => {
  it("is tier 2 and validates plot and kind", () => {
    const tool = makeBuildTool(() => true);
    expect(tool.name).toBe("build");
    expect(tool.tier).toBe(2);
    expect(tool.schema.safeParse({ plot: 0, kind: "house" }).success).toBe(false);
    expect(tool.schema.safeParse({ plot: 7, kind: "house" }).success).toBe(false);
    expect(tool.schema.safeParse({ plot: 3, kind: "castle" }).success).toBe(false);
    expect(tool.schema.safeParse({ plot: 3, kind: "studio" }).success).toBe(true);
  });
  it("reports built or taken from the claim result", async () => {
    expect(await makeBuildTool(() => true).run({ plot: 3, kind: "studio" }, ctx("ada"))).toBe("built studio on plot 3");
    expect(await makeBuildTool(() => false).run({ plot: 3, kind: "studio" }, ctx("ada"))).toBe("plot 3 is taken");
  });
});
