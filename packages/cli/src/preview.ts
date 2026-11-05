import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { loadProjectConfig, type BoardStore } from "@agentcity/safety";
import { resolveUnprotected } from "./project-files.js";
import { workDir } from "./workspace.js";

/** The page in the frame runs scripts but reaches nothing outside its own files. */
// sandbox also holds when the page is opened outside the frame: it never runs as the city origin
export const PREVIEW_CSP = "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'; sandbox allow-scripts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

export interface PreviewDeps {
  home: string;
  board: BoardStore;
  /** Random per city process, separate from the websocket token. */
  key: string;
  /** The port the city listens on. The Host header must be `127.0.0.1:<port>`. */
  port(): number;
}

/** The folder a task's preview and files come from: its worktree while it exists, else the project root. */
export function previewRoot(home: string, task: { projectId: string; worktree: string | null }): string | undefined {
  if (task.worktree && fs.existsSync(task.worktree)) return task.worktree;
  const loaded = loadProjectConfig(home, task.projectId);
  return loaded.ok ? workDir(home, loaded.config, task.projectId) : undefined;
}

const notFound = (res: http.ServerResponse): void => {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  res.end("not found");
};

const sameKey = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * `GET /p/<previewKey>/<taskId>/<path>`: a file of the task worktree, or of the project root once the task has none.
 * Every failure is a 404: a wrong key or Host, an unknown task, `..`, an absolute path, a protected file, a link out of the root.
 */
export async function servePreview(req: http.IncomingMessage, res: http.ServerResponse, d: PreviewDeps): Promise<void> {
  try {
    if (req.headers.host !== `127.0.0.1:${d.port()}`) return notFound(res);
    const m = /^\/p\/([^/]+)\/([^/]+)(\/.*)?$/.exec((req.url ?? "").split(/[?#]/, 1)[0] ?? "");
    if (!m || !sameKey(m[1]!, d.key)) return notFound(res);
    const task = /^t\d+$/.test(m[2]!) ? d.board.task(m[2]!) : undefined;
    if (!task) return notFound(res);
    let decoded: string;
    try {
      decoded = decodeURIComponent(m[3] ?? "/");
    } catch {
      return notFound(res);
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return notFound(res);
    let rel = decoded.replace(/^\/+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const loaded = loadProjectConfig(d.home, task.projectId);
    const root = previewRoot(d.home, task);
    if (!loaded.ok || !root) return notFound(res);
    const abs = await resolveUnprotected(root, rel, loaded.config.protectedPaths);
    if (abs === undefined) return notFound(res);
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) return notFound(res);
    const data = await fs.promises.readFile(abs);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": data.length,
      "Content-Security-Policy": PREVIEW_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    if (!res.headersSent) notFound(res);
    else res.end();
  }
}
