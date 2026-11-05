import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffText, parseDiff, taskDiff } from "../src/diff.js";

const fixture = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const a = 1;",
  "+export const b = 2;",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "index 2222222..0000000",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-gone one",
  "-gone two",
  "diff --git a/a.md b/b.md",
  "similarity index 90%",
  "rename from a.md",
  "rename to b.md",
  "index 3333333..4444444 100644",
  "--- a/a.md",
  "+++ b/b.md",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old line",
  "+new line",
  " end",
  "diff --git a/logo.png b/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

describe("parseDiff", () => {
  it("parses added, deleted, renamed and binary files", () => {
    const files = parseDiff(fixture);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/new.ts", "added"],
      ["old.txt", "deleted"],
      ["b.md", "renamed"],
      ["logo.png", "binary"],
    ]);
    expect(files.map((f) => [f.additions, f.deletions])).toEqual([[2, 0], [0, 2], [1, 1], [0, 0]]);
    expect(files[3]!.hunks).toEqual([]);
  });

  it("numbers lines from the hunk header", () => {
    const files = parseDiff(fixture);
    expect(files[2]!.hunks).toEqual([
      [
        { kind: "ctx", text: "keep", oldNo: 1, newNo: 1 },
        { kind: "del", text: "old line", oldNo: 2 },
        { kind: "add", text: "new line", newNo: 2 },
        { kind: "ctx", text: "end", oldNo: 3, newNo: 3 },
      ],
    ]);
    const offset = parseDiff(["diff --git a/x.txt b/x.txt", "@@ -10,1 +20,2 @@", " a", "+b"].join("\n"));
    expect(offset[0]!.hunks[0]).toEqual([
      { kind: "ctx", text: "a", oldNo: 10, newNo: 20 },
      { kind: "add", text: "b", newNo: 21 },
    ]);
  });

  it("keeps 2000 lines of a 2500 line file and marks it truncated, with full counts", () => {
    const big = [
      "diff --git a/big.txt b/big.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/big.txt",
      "@@ -0,0 +1,2500 @@",
      ...Array.from({ length: 2500 }, (_, i) => `+line ${i}`),
      "",
    ].join("\n");
    const [file] = parseDiff(big);
    expect(file!.hunks.flat().length).toBe(2000);
    expect(file!.truncated).toBe(true);
    expect(file!.additions).toBe(2500);
  });

  it("keeps 200 of 250 files", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      [`diff --git a/f${i}.txt b/f${i}.txt`, `--- a/f${i}.txt`, `+++ b/f${i}.txt`, "@@ -1 +1 @@", "-a", "+b"].join("\n"),
    ).join("\n") + "\n";
    const files = parseDiff(many);
    expect(files.length).toBe(200);
    expect(files[199]!.path).toBe("f199.txt");
  });
});

describe("diffText", () => {
  it("writes the lines with their markers and stays within the limit", () => {
    const files = parseDiff(fixture);
    const text = diffText(files);
    expect(text).toContain("+export const a = 1;");
    expect(text).toContain("-gone one");
    expect(diffText(files, 120).length).toBeLessThanOrEqual(120);
  });
});

describe("taskDiff", () => {
  it("reads base...branch from git in the repo", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-diff-repo-"));
    try {
      const sh = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
      sh("init", "-q", "-b", "main");
      fs.writeFileSync(path.join(repo, "readme.md"), "hi\n");
      sh("add", ".");
      sh("commit", "-q", "-m", "init");
      sh("switch", "-q", "-c", "agent/ada/t2");
      fs.writeFileSync(path.join(repo, "new.txt"), "one\n");
      sh("add", "-A");
      sh("commit", "-q", "-m", "t2");
      sh("switch", "-q", "main");
      const files = taskDiff(repo, "main", "agent/ada/t2");
      expect(files.map((f) => [f.path, f.status, f.additions])).toEqual([["new.txt", "added", 1]]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
