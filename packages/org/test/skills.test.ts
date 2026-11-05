import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillStore } from "../src/skills.js";

let home: string;
beforeEach(() => (home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-skills-"))));
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("SkillStore", () => {
  it("saves, lists, reads and removes a skill", () => {
    const s = new SkillStore(home);
    s.save("cover-letter", "Write a cover letter", "Keep it to 200 words.");
    expect(s.list()).toEqual([{ name: "cover-letter", description: "Write a cover letter" }]);
    expect(s.get("cover-letter")?.body).toContain("200 words");
    s.remove("cover-letter");
    expect(s.list()).toEqual([]);
    expect(s.get("cover-letter")).toBeUndefined();
  });

  it("refuses bad names", () => {
    const s = new SkillStore(home);
    expect(() => s.save("../x", "d", "b")).toThrow();
    expect(() => s.save("Big Name", "d", "b")).toThrow();
  });
});
