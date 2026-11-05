import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deleteFileTool, editFileTool, globToRegExp, listFilesTool, relPath, runCommandTool, searchFilesTool, commandEnv,
  OUTPUT_CHARS, FOLDER_LIMIT, LIST_LIMIT, type ToolContext,
} from "../src/tools/index.js";

let root: string;
let ctx: ToolContext;
const put = async (rel: string, text: string | Buffer) => {
  const full = path.join(ctx.sandboxDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ac-ws-"));
  ctx = { projectId: "p", agentId: "a", sandboxDir: path.join(root, "box"), outboxDir: path.join(root, "out") };
  await fs.mkdir(ctx.sandboxDir);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("globToRegExp and relPath", () => {
  it.each([
    [".env*", ".env", true], [".env*", "app/.env.local", true], [".env*", "env", false],
    [".git/**", ".git/config", true], [".git/**", "src/.git/config", false],
    ["src/**/*.ts", "src/a.ts", true], ["src/**/*.ts", "src/x/y/a.ts", true], ["src/**/*.ts", "lib/a.ts", false],
    ["*.ts", "deep/a.ts", true], ["a?.txt", "ab.txt", true], ["a?.txt", "a/.txt", false],
  ])("%s on %s is %s", (g, p, want) => {
    expect(globToRegExp(g, false).test(p)).toBe(want);
  });
  it("relPath normalizes and refuses paths that leave the folder", () => {
    expect(relPath("./src\\a.ts")).toBe("src/a.ts");
    expect(relPath("src/../b.ts")).toBe("b.ts");
    expect(relPath("../x")).toBeNull();
    expect(relPath("/etc/passwd")).toBeNull();
    expect(relPath("C:\\x")).toBeNull();
  });
});

describe("list_files", () => {
  it("lists sorted, marks folders, skips .git and node_modules", async () => {
    await put("b.txt", "1");
    await put("src/a.ts", "1");
    await put(".git/config", "1");
    await put("node_modules/x/i.js", "1");
    expect(await listFilesTool.run({}, ctx)).toBe("b.txt\nsrc/\nsrc/a.ts");
    expect(await listFilesTool.run({ path: "src" }, ctx)).toBe("src/a.ts");
  });
  it("refuses a folder outside the project", async () => {
    await expect(listFilesTool.run({ path: ".." }, ctx)).rejects.toThrow(/escapes/);
  });
  it("folds a folder of more than FOLDER_LIMIT entries into one line, and lists it when asked by path", async () => {
    expect(FOLDER_LIMIT).toBe(100);
    for (let i = 0; i < 101; i++) await put(`big/f${String(i).padStart(3, "0")}.png`, "1");
    for (let i = 0; i < 100; i++) await put(`ok/f${String(i).padStart(3, "0")}.txt`, "1");
    await put("a.txt", "1");
    const top = (await listFilesTool.run({}, ctx)).split("\n");
    expect(top[0]).toBe("a.txt");
    expect(top[1]).toBe("big/ (more than 100 entries, not listed. Use list_files with path \"big\" to see them.)");
    expect(top[2]).toBe("ok/");
    expect(top).toHaveLength(103);
    const big = (await listFilesTool.run({ path: "big" }, ctx)).split("\n");
    expect(big).toHaveLength(101);
    expect(big[0]).toBe("big/f000.png");
  });
  it("stops at LIST_LIMIT lines", async () => {
    expect(LIST_LIMIT).toBe(300);
    for (let d = 0; d < 4; d++) for (let i = 0; i < 90; i++) await put(`d${d}/f${String(i).padStart(2, "0")}.txt`, "1");
    const out = (await listFilesTool.run({}, ctx)).split("\n");
    expect(out).toHaveLength(301);
    expect(out[300]).toBe("[list cut at 300 lines]");
  });
});

describe("search_files", () => {
  it("finds lines with file and line number, filters by glob, skips binary files", async () => {
    await put("a.ts", "one\nconst foo = 1;\n");
    await put("b.md", "foo in docs");
    await put("bin.dat", Buffer.from([102, 111, 111, 0, 1]));
    expect(await searchFilesTool.run({ pattern: "foo" }, ctx)).toBe("a.ts:2: const foo = 1;\nb.md:1: foo in docs");
    expect(await searchFilesTool.run({ pattern: "foo", glob: "*.ts" }, ctx)).toBe("a.ts:2: const foo = 1;");
    expect(await searchFilesTool.run({ pattern: "nothing" }, ctx)).toBe("no matches");
  });
  it("reports a bad pattern", async () => {
    await expect(searchFilesTool.run({ pattern: "(" }, ctx)).rejects.toThrow(/invalid pattern/);
  });
});

describe("edit_file", () => {
  it("replaces one exact match literally", async () => {
    await put("a.txt", "hello world");
    expect(await editFileTool.run({ path: "a.txt", old: "world", new: "$& there" }, ctx)).toBe("edited a.txt (1 replacement)");
    expect(await fs.readFile(path.join(ctx.sandboxDir, "a.txt"), "utf8")).toBe("hello $& there");
  });
  it("refuses missing and repeated text unless replaceAll", async () => {
    await put("a.txt", "x x");
    await expect(editFileTool.run({ path: "a.txt", old: "y", new: "z" }, ctx)).rejects.toThrow(/not found/);
    await expect(editFileTool.run({ path: "a.txt", old: "x", new: "z" }, ctx)).rejects.toThrow(/2 times/);
    expect(await editFileTool.run({ path: "a.txt", old: "x", new: "z", replaceAll: true }, ctx)).toContain("2 replacements");
    expect(await fs.readFile(path.join(ctx.sandboxDir, "a.txt"), "utf8")).toBe("z z");
  });
  it("decodes \\n and \\t typed as two characters when the exact text is missing", async () => {
    await put("a.js", "  // step\n\tgo();\n");
    expect(await editFileTool.run({ path: "a.js", old: "  // step\\n\\tgo();", new: "  // step\\n\\tgo();\\n\\tstop();" }, ctx)).toBe(
      "edited a.js (1 replacement)",
    );
    expect(await fs.readFile(path.join(ctx.sandboxDir, "a.js"), "utf8")).toBe("  // step\n\tgo();\n\tstop();\n");
  });
  it("keeps a real backslash n when the exact text matches", async () => {
    await put("a.js", 'say("a\\nb");');
    await editFileTool.run({ path: "a.js", old: 'say("a\\nb");', new: 'say("a\\nc");' }, ctx);
    expect(await fs.readFile(path.join(ctx.sandboxDir, "a.js"), "utf8")).toBe('say("a\\nc");');
  });
  it("matches whole lines that differ only in indentation when exactly one place fits", async () => {
    await put("a.js", "if (x) {\n    go();\n    stop();\n}\n");
    expect(await editFileTool.run({ path: "a.js", old: "  go();\n  stop();", new: "    run();" }, ctx)).toBe("edited a.js (1 replacement)");
    expect(await fs.readFile(path.join(ctx.sandboxDir, "a.js"), "utf8")).toBe("if (x) {\n    run();\n}\n");
    await put("b.js", "  go();\n    go();\n");
    await expect(editFileTool.run({ path: "b.js", old: "go();", new: "x" }, ctx)).rejects.toThrow(/2 times/);
    await expect(editFileTool.run({ path: "b.js", old: "\tgo();", new: "x" }, ctx)).rejects.toThrow(/not found/);
  });
  it("tells the model to read the file again when the text is missing", async () => {
    await put("a.txt", "x");
    await expect(editFileTool.run({ path: "a.txt", old: "y", new: "z" }, ctx)).rejects.toThrow(
      "text not found in a.txt; read_file it again and copy the exact lines, or write_file the whole file",
    );
  });
});

describe("delete_file", () => {
  it("deletes a file and refuses a folder", async () => {
    await put("d/a.txt", "1");
    expect(await deleteFileTool.run({ path: "d/a.txt" }, ctx)).toBe(`deleted ${path.join("d", "a.txt")}`);
    await expect(fs.access(path.join(ctx.sandboxDir, "d", "a.txt"))).rejects.toThrow();
    await expect(deleteFileTool.run({ path: "d" }, ctx)).rejects.toThrow(/not a file/);
  });
});

describe("run_command", () => {
  it("runs in the project folder and returns the exit code and output", async () => {
    await put("marker.txt", "here");
    const cmd = process.platform === "win32" ? "type marker.txt" : "cat marker.txt";
    expect(await runCommandTool.run({ command: cmd }, ctx)).toBe("exit code 0\nhere");
    expect(await runCommandTool.run({ command: `node -e "process.exit(3)"` }, ctx)).toBe("exit code 3");
  });
  it("keeps only the end of long output", async () => {
    const out = await runCommandTool.run({ command: `node -e "process.stdout.write('a'.repeat(50000)+'END')"` }, ctx);
    expect(out).toContain("[output cut");
    expect(out.endsWith("END")).toBe(true);
    expect(out.length).toBeLessThan(OUTPUT_CHARS + 200);
  });
  it("kills a command that runs past its timeout", async () => {
    const t = Date.now();
    const out = await runCommandTool.run({ command: `node -e "setTimeout(()=>{},60000)"`, timeoutSec: 1 }, ctx);
    expect(out).toBe("stopped: timed out after 1 s");
    expect(Date.now() - t).toBeLessThan(10_000);
  });
  it("stops on abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect(await runCommandTool.run({ command: `node -e "setTimeout(()=>{},60000)"` }, { ...ctx, signal: ac.signal })).toBe("stopped: aborted");
  });
  it("drops credential variables from the environment", () => {
    expect(commandEnv({ PATH: "p", OPENAI_API_KEY: "k", GH_TOKEN: "t", MY_SECRET: "s", HOME: "h" })).toEqual({ PATH: "p", HOME: "h" });
  });
});
