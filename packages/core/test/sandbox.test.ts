import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveInSandbox, SandboxError } from "../src/tools/index.js";

let root: string;
let sandbox: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ac-sbx-"));
  sandbox = path.join(root, "box");
  await fs.mkdir(sandbox);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("resolveInSandbox", () => {
  it("allows a nested path", async () => {
    await fs.mkdir(path.join(sandbox, "a"));
    await fs.writeFile(path.join(sandbox, "a", "f.txt"), "x");
    const r = await resolveInSandbox(sandbox, "a/f.txt");
    expect(r.toLowerCase()).toContain(path.join("a", "f.txt").toLowerCase());
  });
  it("rejects ..", async () => {
    await expect(resolveInSandbox(sandbox, "../x")).rejects.toBeInstanceOf(SandboxError);
  });
  it("rejects an absolute path outside", async () => {
    await expect(resolveInSandbox(sandbox, path.join(root, "other.txt"))).rejects.toBeInstanceOf(SandboxError);
  });
  it("rejects a symlink pointing outside", async (ctx) => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, path.join(sandbox, "link"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw e;
    }
    await expect(resolveInSandbox(sandbox, "link/f.txt")).rejects.toBeInstanceOf(SandboxError);
  });
  it("rejects a dangling symlink pointing outside", async (ctx) => {
    const missing = path.join(root, "not-yet");
    try {
      await fs.symlink(missing, path.join(sandbox, "dangling"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw e;
    }
    await expect(resolveInSandbox(sandbox, "dangling")).rejects.toBeInstanceOf(SandboxError);
    await expect(resolveInSandbox(sandbox, "dangling/f.txt")).rejects.toBeInstanceOf(SandboxError);
  });
  it("allows a not-yet-existing file", async () => {
    const r = await resolveInSandbox(sandbox, "new/dir/f.txt");
    expect(r.toLowerCase()).toContain("f.txt");
  });
  it.runIf(process.platform === "win32")("win32: accepts different case of the sandbox path", async () => {
    await fs.writeFile(path.join(sandbox, "f.txt"), "x");
    const r = await resolveInSandbox(sandbox.toUpperCase(), "f.txt");
    expect(r.toLowerCase()).toContain("f.txt");
  });
  it.runIf(process.platform === "win32")("win32: rejects another drive and UNC", async () => {
    const other = sandbox.slice(0, 1).toLowerCase() === "d" ? "E:\\x" : "D:\\x";
    await expect(resolveInSandbox(sandbox, other)).rejects.toBeInstanceOf(SandboxError);
    await expect(resolveInSandbox(sandbox, "\\\\server\\share\\x")).rejects.toBeInstanceOf(SandboxError);
  });
});
