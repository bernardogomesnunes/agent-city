import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readFileTool, writeFileTool, sendMessageTool, builtInTools, toolSpec, SandboxError, READ_LIMIT,
  type ToolContext,
} from "../src/tools/index.js";

let root: string;
let ctx: ToolContext;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ac-tools-"));
  ctx = { projectId: "p", agentId: "a", sandboxDir: path.join(root, "box"), outboxDir: path.join(root, "out") };
  await fs.mkdir(ctx.sandboxDir);
  await fs.mkdir(ctx.outboxDir);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("tools", () => {
  it("read_file reads a file", async () => {
    await fs.writeFile(path.join(ctx.sandboxDir, "a.txt"), "hello");
    expect(await readFileTool.run({ path: "a.txt" }, ctx)).toBe("hello");
  });
  it("read_file cuts at 60000 characters", async () => {
    await fs.writeFile(path.join(ctx.sandboxDir, "big.txt"), "a".repeat(150000));
    const out = await readFileTool.run({ path: "big.txt" }, ctx);
    expect(READ_LIMIT).toBe(60_000);
    expect(out.length).toBe(60000 + "\n[file cut at 60000 characters]".length);
    expect(out.endsWith("\n[file cut at 60000 characters]")).toBe(true);
  });
  it("write_file writes inside sandbox", async () => {
    const r = await writeFileTool.run({ path: "d/n.txt", content: "abc" }, ctx);
    expect(r).toBe(`wrote 3 bytes to ${path.join("d", "n.txt")}`);
    expect(await fs.readFile(path.join(ctx.sandboxDir, "d", "n.txt"), "utf8")).toBe("abc");
  });
  it("write_file rejects ../escape.txt", async () => {
    await expect(writeFileTool.run({ path: "../escape.txt", content: "x" }, ctx)).rejects.toBeInstanceOf(SandboxError);
  });
  it("send_message writes one JSON file to outbox", async () => {
    const r = await sendMessageTool.run({ to: "a@b.c", body: "hi" }, ctx);
    const files = await fs.readdir(ctx.outboxDir);
    expect(files).toHaveLength(1);
    expect(r).toBe(`queued: ${files[0]}`);
    expect(files[0]).toMatch(/^\d+-[0-9a-f]{4}\.json$/);
    expect(JSON.parse(await fs.readFile(path.join(ctx.outboxDir, files[0]!), "utf8"))).toEqual({ to: "a@b.c", body: "hi" });
  });
  it("built-in tools and their tiers", () => {
    expect(builtInTools.map((t) => t.tier)).toEqual([0, 1, 2, 0, 0, 1, 2, 2]);
    expect(builtInTools.map((t) => t.name)).toEqual([
      "read_file", "write_file", "send_message", "list_files", "search_files", "edit_file", "delete_file", "run_command",
    ]);
  });
  it("toolSpec has an object inputSchema with required path", () => {
    const s = toolSpec(readFileTool);
    expect(s.inputSchema.type).toBe("object");
    expect(s.inputSchema.required).toContain("path");
  });
});
