import fs from "node:fs/promises";
import path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const UNC = /^[\\/]{2}/;
const isWin =() => process.platform === "win32";
const norm = (p: string) => (isWin() ? p.toLowerCase() : p);

async function realDeepestAncestor(target: string): Promise<string> {
  let cur = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      // a dangling symlink or junction would be followed by a later write
      const st = await fs.lstat(cur).catch(() => null);
      if (st?.isSymbolicLink()) throw new SandboxError(`dangling link rejected: ${target}`);
      const parent = path.dirname(cur);
      if (parent === cur) throw new SandboxError(`path not resolvable: ${target}`);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Resolve p inside sandboxDir. Throws SandboxError when the real target leaves the sandbox. */
export async function resolveInSandbox(sandboxDir: string, p: string): Promise<string> {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) throw new SandboxError("invalid path");
  if (isWin() && UNC.test(p)) throw new SandboxError(`UNC path rejected: ${p}`);
  const realSandbox = await fs.realpath(sandboxDir);
  if (isWin() && UNC.test(realSandbox)) throw new SandboxError("sandbox on a UNC path");
  const abs = path.resolve(realSandbox, p);
  if (isWin()) {
    if (UNC.test(abs)) throw new SandboxError(`UNC path rejected: ${p}`);
    if (path.parse(abs).root.toLowerCase() !== path.parse(realSandbox).root.toLowerCase()) {
      throw new SandboxError(`path on a different drive: ${p}`);
    }
  }
  const realTarget = await realDeepestAncestor(abs);
  const a = norm(realSandbox);
  const b = norm(realTarget);
  const rel = path.relative(a, b);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new SandboxError(`path escapes the sandbox: ${p}`);
  }
  return realTarget;
}
