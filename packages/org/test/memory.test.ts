import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/index.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe("MemoryStore", () => {
  it("append then read", () => {
    const m = new MemoryStore(home);
    expect(m.read("ada")).toBe("");
    m.append("ada", "one");
    m.append("ada", "two");
    expect(m.read("ada")).toBe("one\ntwo");
    expect(fs.existsSync(path.join(home, "agents", "ada", "memory", "notes.md"))).toBe(true);
  });
  it("tail keeps whole lines", () => {
    const m = new MemoryStore(home);
    m.append("ada", "aaaaaaaaaa");
    m.append("ada", "bbbbbbbbbb");
    m.append("ada", "cccccccccc");
    expect(m.tail("ada", 100)).toBe(m.read("ada"));
    expect(m.tail("ada", 25)).toBe("bbbbbbbbbb\ncccccccccc");
  });
  it("tail of one 5000-char line returns its last 4000 chars", () => {
    const m = new MemoryStore(home);
    m.append("ada", "x".repeat(4990) + "0123456789");
    const t = m.tail("ada", 4000);
    expect(t).toHaveLength(4000);
    expect(t.endsWith("0123456789")).toBe(true);
  });
  it("clear empties the file", () => {
    const m = new MemoryStore(home);
    m.append("ada", "one");
    m.clear("ada");
    expect(m.read("ada")).toBe("");
  });
  it("rejects ids that could escape agents/", () => {
    const m = new MemoryStore(home);
    for (const bad of ["../x", "a/b", "", "CON"]) {
      expect(() => m.read(bad)).toThrow(/invalid id/);
      expect(() => m.append(bad, "x")).toThrow(/invalid id/);
      expect(() => m.clear(bad)).toThrow(/invalid id/);
      expect(() => m.tail(bad, 10)).toThrow(/invalid id/);
    }
  });
});
