import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentStore } from "../src/index.js";

let home: string;
let tick: number;
const now = () => new Date(Date.UTC(2026, 9, 29, 12, 0, tick++));
const input = { id: "ada", name: "Ada", role: "worker" as const, persona: "You are Ada.", model: "lmstudio/qwen3-8b" };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "org-"));
  tick = 0;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("AgentStore", () => {
  it("remove deletes the profile, versions and notes, and says false for an unknown or bad id", () => {
    const store = new AgentStore(home, now);
    store.create(input);
    store.create({ ...input, id: "bob", name: "Bob" });
    fs.writeFileSync(path.join(home, "agents", "ada", "memory", "notes.md"), "- a note");
    expect(store.remove("ada")).toBe(true);
    expect(fs.existsSync(path.join(home, "agents", "ada"))).toBe(false);
    expect(store.list().map((p) => p.id)).toEqual(["bob"]);
    expect(store.remove("ada")).toBe(false);
    expect(store.remove("../bob")).toBe(false);
    expect(store.get("bob")).toBeDefined();
  });
  it('create rejects agent id "nul"', () => {
    expect(() => new AgentStore(home, now).create({ ...input, id: "nul" })).toThrow();
  });
  it('id "console" is allowed', () => {
    expect(new AgentStore(home, now).create({ ...input, id: "console" }).id).toBe("console");
  });
  it("create writes agent.json, versions/1.json and memory/", () => {
    const p = new AgentStore(home, now).create(input);
    const dir = path.join(home, "agents", "ada");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8"))).toEqual(p);
    expect(fs.existsSync(path.join(dir, "versions", "1.json"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "memory"))).toEqual([]);
    expect(p.version).toBe(1);
    expect(p.createdAt).toBe("2026-10-29T12:00:00.000Z");
  });
  it("create rejects an existing id", () => {
    const s = new AgentStore(home, now);
    s.create(input);
    expect(() => s.create(input)).toThrow();
  });
  it('create rejects id "Bad_Id"', () => {
    expect(() => new AgentStore(home, now).create({ ...input, id: "Bad_Id" })).toThrow();
  });
  it("create rejects empty persona", () => {
    expect(() => new AgentStore(home, now).create({ ...input, persona: "" })).toThrow();
  });
  it("persona edit bumps to version 2 and keeps version 1", () => {
    const s = new AgentStore(home, now);
    s.create(input);
    const p = s.update("ada", { persona: "New persona." });
    expect(p.version).toBe(2);
    expect(s.getVersion("ada", 1)?.persona).toBe("You are Ada.");
    expect(s.getVersion("ada", 2)?.persona).toBe("New persona.");
    expect(s.versions("ada").map((v) => v.version)).toEqual([1, 2]);
  });
  it("model edit bumps version", () => {
    const s = new AgentStore(home, now);
    s.create(input);
    expect(s.update("ada", { model: "claude-haiku-5-5" }).version).toBe(2);
  });
  it("old agent.json without building loads as software", () => {
    const s = new AgentStore(home, now);
    s.create(input);
    const f = path.join(home, "agents", "ada", "agent.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    delete j.building;
    fs.writeFileSync(f, JSON.stringify(j));
    expect(s.get("ada")?.building).toBe("software");
  });
  it("create with building visual round-trips", () => {
    const s = new AgentStore(home, now);
    s.create({ ...input, building: "visual" });
    expect(s.get("ada")?.building).toBe("visual");
  });
  it("building edit bumps version", () => {
    const s = new AgentStore(home, now);
    s.create(input);
    const u = s.update("ada", { building: "visual" });
    expect(u.version).toBe(2);
    expect(s.getVersion("ada", 2)?.building).toBe("visual");
  });
  it("name-only edit keeps version 1", () => {
    const s = new AgentStore(home, now);
    const c = s.create(input);
    const p = s.update("ada", { name: "Ada L." });
    expect(p.version).toBe(1);
    expect(p.name).toBe("Ada L.");
    expect(p.updatedAt).not.toBe(c.updatedAt);
    expect(s.versions("ada")).toHaveLength(1);
  });
  it("list is sorted by id", () => {
    const s = new AgentStore(home, now);
    s.create({ ...input, id: "zed" });
    s.create({ ...input, id: "abe" });
    expect(s.list().map((a) => a.id)).toEqual(["abe", "zed"]);
  });
  it("get returns undefined for a missing id", () => {
    const s = new AgentStore(home, now);
    expect(s.get("nope")).toBeUndefined();
    expect(s.get("../x")).toBeUndefined();
    expect(s.getVersion("nope", 1)).toBeUndefined();
  });
  it("update throws for a missing id", () => {
    expect(() => new AgentStore(home, now).update("nope", { name: "x" })).toThrow();
  });
});
