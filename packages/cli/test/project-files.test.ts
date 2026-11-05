import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILE_MAX, TREE_MAX, listFiles, readProjectFile } from "../src/project-files.js";

let root: string;
let outside: string;
const write = (rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-files-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "ac-files-out-"));
  write("index.html", "<html></html>");
  write("src/a.ts", "export const a = 1;\n");
  write(".env", "KEY=1");
  write(".git/HEAD", "ref");
  write("node_modules/x/i.js", "1");
  write("big.txt", "a".repeat(300 * 1024));
  write("bin.dat", Buffer.concat([Buffer.from("PK"), Buffer.from([0, 1, 2]), Buffer.from("tail")]));
  write("late.bin", Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0])]));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("listFiles", () => {
  it("lists a sorted tree without .git, node_modules and protected paths", async () => {
    const t = await listFiles(root, [".env*", ".git/**"]);
    expect(t.entries.map((e) => e.path)).toEqual(["big.txt", "bin.dat", "index.html", "late.bin", "src", "src/a.ts"]);
    expect(t.entries.find((e) => e.path === "src")!.dir).toBe(true);
    expect(t.entries.find((e) => e.path === "src/a.ts")!.size).toBe(20);
    expect(t.truncated).toBe(false);
  });

  it("stops at 500 entries and says so", async () => {
    for (let i = 0; i < 600; i++) write(`many/f${String(i).padStart(3, "0")}.txt`, "x");
    const t = await listFiles(root, []);
    expect(t.entries).toHaveLength(TREE_MAX);
    expect(t.truncated).toBe(true);
  });

  it("a missing root gives an error and no entries", async () => {
    expect(await listFiles(path.join(root, "nope"), [])).toEqual({ entries: [], truncated: false, error: "folder not found" });
  });
});

describe("readProjectFile", () => {
  it("reads a text file", async () => {
    expect(await readProjectFile(root, "src/a.ts", [])).toEqual({ text: "export const a = 1;\n", binary: false, truncated: false });
  });

  it("cuts a file over 200 KB", async () => {
    const r = await readProjectFile(root, "big.txt", []);
    expect(r.text).toHaveLength(FILE_MAX);
    expect(FILE_MAX).toBe(204800);
    expect(r.truncated).toBe(true);
  });

  it("a NUL byte in the first 8 KB makes it binary; one after that does not", async () => {
    const b = await readProjectFile(root, "bin.dat", []);
    expect(b.binary).toBe(true);
    expect(b.text).toBeUndefined();
    expect((await readProjectFile(root, "late.bin", [])).binary).toBe(false);
  });

  it("refuses .., an absolute path, a protected file and a missing file", async () => {
    for (const p of ["../x", "..\\x","C:/Windows/win.ini", "/etc/passwd", ".env", ".git/HEAD", "nope.txt", ""]) {
      const r = await readProjectFile(root, p, [".env*", ".git/**"]);
      expect(r.error, p).toBeTruthy();
      expect(r.text, p).toBeUndefined();
    }
  });

  it("refuses a link inside the root that points at a protected path", async () => {
    fs.symlinkSync(path.join(root, ".git"), path.join(root, "meta"), "junction");
    const r = await readProjectFile(root, "meta/HEAD", [".env*", ".git/**"]);
    expect(r.error).toBe("protected path");
    expect(r.text).toBeUndefined();
  });

  it("refuses a link that leaves the root", async () => {
    fs.writeFileSync(path.join(outside, "f.txt"), "secret");
    fs.symlinkSync(outside, path.join(root, "out"), "junction");
    const r = await readProjectFile(root, "out/f.txt", []);
    expect(r.error).toBeTruthy();
    expect(r.text).toBeUndefined();
    const t = await listFiles(root, []);
    expect(t.entries.some((e) => e.path.startsWith("out/"))).toBe(false);
  });
});
