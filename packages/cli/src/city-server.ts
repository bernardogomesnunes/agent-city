import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Provider } from "@agentcity/core";
import { ActionLog, BoardStore, loadGlobalConfig, loadProjectConfig, openDb, redact, SessionStore, type Task } from "@agentcity/safety";
import { AgentStore, parseModelId } from "@agentcity/org";
import { CityFeed, Ticker } from "@agentcity/world";
import { parseClientMsg, type CityState, type GoalView, type ServerMsg, type TaskView } from "@agentcity/world/shared";
import { readSecrets } from "./secrets.js";
import { listModels } from "./models.js";
import { RunHost } from "./run-host.js";
import { WebApprovals } from "./web-approver.js";
import { TerminalSession } from "./terminal-session.js";
import { hqConfig, runHqCommand } from "./hq.js";
import { removedText } from "./worktrees.js";
import { startMcpSignIn } from "./mcp.js";
import { scanPorts } from "./ports.js";
import { hqStats } from "./stats.js";
import { SessionHost } from "./session-host.js";
import { JobRunner, type Job } from "./job-runner.js";
import { Scheduler } from "./scheduler.js";
import { listFiles, readProjectFile, type ProjectFile } from "./project-files.js";
import { previewRoot, servePreview } from "./preview.js";
import { taskDiff } from "./diff.js";
import { cityLockPort, removeCityLock, writeCityLock } from "./link.js";
import { toLogRows } from "./task-log.js";
import { baseBranch, workDir } from "./workspace.js";
import { listDecisions, trackSeen } from "./decisions.js";

/** Per-client terminal handler. The default is a `TerminalSession`. */
export interface TermHandler {
  onLine(line: string): void;
  close(): void;
}

export interface CityOptions {
  home: string;
  port: number;
  staticDir: string;
  token?: string;
  providerOverride?: Provider;
  pollMs?: number;
  /** Replaces the default `TerminalSession`. Called once per websocket client. */
  makeTermHandler?: (send: (m: ServerMsg) => void) => TermHandler;
  /** Replaces fetch for the models list. Used by tests. */
  fetch?: typeof fetch;
}

export interface CityServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
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

const notFound = (res: http.ServerResponse): void => {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
};

/** Maps a request target to a file under root. Undefined for traversal or bad encoding. */
function resolveStatic(root: string, target: string): string | undefined {
  const rawPath = target.split(/[?#]/, 1)[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^[/\\]+/, "");
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return undefined;
  return abs;
}

/** Puts the websocket token into the page, so a bookmark of the plain address connects. */
export function withToken(html: Buffer, token: string): Buffer {
  return Buffer.from(html.toString("utf8").replace("<head>", `<head><meta name="agentcity-token" content="${token}">`), "utf8");
}

export async function startCityServer(o: CityOptions): Promise<CityServer> {
  const running = cityLockPort(o.home);
  if (running !== undefined) throw new Error(`a city already runs on this home (port ${running})`);
  const token = o.token ?? randomBytes(16).toString("hex");
  const db = openDb(o.home);
  const keys = readSecrets(o.home);
  const secrets = Object.values(keys);
  const approvals = new WebApprovals();
  const agents = new AgentStore(o.home);
  const feed = new CityFeed(db, {
    listAgents: () => agents.list().map((p) => ({ id: p.id, name: p.name, role: p.role, building: p.building, model: p.model })),
    localApprovalIds: () => approvals.waiting(),
    redactText: (s) => redact(s, secrets),
  });
  const host = new RunHost({
    home: o.home, db, secrets, keys,
    providerOverride: o.providerOverride, approvals,
    out: () => undefined, // The city shows activity from the action log.
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set<WebSocket>();
  const termHandlers = new Map<WebSocket, TermHandler>();
  let current: CityState = feed.poll().state;
  let prevAgentIds = new Set(current.agents.map((a) => a.id));
  let closed = false;
  let pollFailing = false;

  const sendTo = (ws: WebSocket, m: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const broadcast = (m: ServerMsg): void => {
    for (const ws of clients) sendTo(ws, m);
  };
  // Board jobs and chat turns share one runner. Keys and connections are read per job, so ones added after the start work.
  const jobs: Pick<JobRunner, "run"> = {
    run: (job: Job, tools, signal, inbox) => {
      const fresh = readSecrets(o.home);
      Object.assign(keys, fresh);
      for (const v of Object.values(fresh)) if (!secrets.includes(v)) secrets.push(v);
      return new JobRunner({
        home: o.home, db, secrets, keys, global: loadGlobalConfig(o.home),
        providerOverride: o.providerOverride, approvals, out: () => undefined,
      }).run(job, tools, signal, inbox);
    },
  };
  const board = new BoardStore(db, secrets);
  /** The first-seen time of each pending approval. */
  const seenApprovals = new Map<number, string>();
  /** The last decisions message. Sent on connect, and on tick when the key changes. */
  let lastDecisions: ServerMsg = { type: "decisions", list: [], failing: [] };
  let decisionsKey = "";
  /** Recomputes the decisions. True when the list of ids or the failing agents changed. */
  const computeDecisions = (): boolean => {
    trackSeen(seenApprovals, current.approvals.map((a) => a.id), new Date().toISOString());
    const tasks = board.waitingTasks();
    const activeGoals = new Set(tasks.map((t) => t.goalId).filter((id) => ["active", "planning"].includes(board.goal(id)?.status ?? "")));
    const { list, failing } = listDecisions({ approvals: current.approvals, seen: seenApprovals, tasks, goals: board.plansWaiting(), activeGoals });
    const key = JSON.stringify(list.map((d) => (d.kind === "plan" ? `${d.id}:${d.since}` : d.id))) + "|" + failing.join(",");
    if (key === decisionsKey) return false;
    decisionsKey = key;
    lastDecisions = { type: "decisions", list, failing };
    return true;
  };
  computeDecisions();
  const logError = (line: string): void => void process.stderr.write(`${line}\n`);
  /** Clients that sent board.watch, with the projects they watch. */
  const watchers = new Map<WebSocket, Set<string>>();
  /** Per client: the task it has open and the id of the newest log row it has. */
  const openTasks = new Map<WebSocket, { taskId: string; cursor: number }>();
  const previewKey = randomBytes(16).toString("hex");
  const actionLog = new ActionLog(db, secrets);
  const scheduler: Scheduler = new Scheduler({
    home: o.home, board, jobs, agents, log: logError,
    runRows: (id) => actionLog.ofRuns([id]),
    onChange: (projectId) => pushBoard(projectId),
    chatting: (agentId) => sessions.chatting(agentId),
    projectBusy: (projectId) => host.busy(projectId),
    chatBusy: (projectId) => sessions.projectChatting(projectId),
    abortChats: (projectId) => sessions.abortProject(projectId),
    onAgentFree: (agentId) => sessions.pump(agentId),
  });
  const sessions: SessionHost = new SessionHost({
    home: o.home, store: new SessionStore(db, secrets), agents, jobs, scheduler, log: logError,
    board, runRows: (id) => actionLog.ofRuns([id]), redactText: (s) => redact(s, secrets),
    projectBusy: (projectId) => host.busy(projectId),
    onMessage: (message) => broadcast({ type: "session.msg", message }),
    onList: () => broadcast({ type: "session.list", sessions: sessions.list() }),
  });
  sessions.start();

  /** Every field of the task except the scheduler's counters. */
  const taskView = (t: Task): TaskView => ({
    id: t.id, goalId: t.goalId, parentId: t.parentId, projectId: t.projectId, title: t.title, description: t.description,
    assignee: t.assignee, deps: t.deps, status: t.status, branch: t.branch, worktree: t.worktree, summary: t.summary,
    blockedReason: t.blockedReason, ci: t.ci, testOutput: t.testOutput, checkpoint: t.checkpoint, held: t.held, createdBy: t.createdBy, createdAt: t.createdAt, updatedAt: t.updatedAt,
  });
  const boardMsg = (projectId: string): ServerMsg => {
    const goals: GoalView[] = board.goals(projectId).map((g) => ({ ...g, ...board.progress(g.id) }));
    const tasks = board.goals(projectId).flatMap((g) => board.tasks(g.id).map(taskView));
    return { type: "board", projectId, goals, tasks };
  };
  function pushBoard(projectId: string): void {
    if (closed) return;
    try {
      let msg: ServerMsg | undefined;
      for (const [ws, projects] of watchers) {
        if (!projects.has(projectId)) continue;
        msg ??= boardMsg(projectId);
        sendTo(ws, msg);
      }
    } catch (e) {
      logError(`board push error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const projectOk = (projectId: string): boolean => {
    try {
      return loadProjectConfig(o.home, projectId).ok;
    } catch {
      return false;
    }
  };
  /** The task, when it belongs to a project the client watches. Otherwise undefined. */
  const ownTask = (ws: WebSocket, taskId: string): Task | undefined => {
    const t = board.task(taskId);
    return t && watchers.get(ws)?.has(t.projectId) ? t : undefined;
  };
  /** The decisions list goes to every client, so J may answer an item of a project the client never watched. */
  const listed = (key: "taskId" | "goalId", id: string): boolean =>
    lastDecisions.type === "decisions" && lastDecisions.list.some((d) => d[key] === id);
  /** The task, when the client watches its project or the task is in the decisions list. */
  const answerableTask = (ws: WebSocket, taskId: string): Task | undefined =>
    ownTask(ws, taskId) ?? (listed("taskId", taskId) ? board.task(taskId) : undefined);
  const runIdsOf = (taskId: string): string[] => board.runs(taskId).map((r) => r.runId);
  const redactText = (s: string): string => redact(s, secrets);
  /** Sends new log rows of each client's open task. */
  const pushLogs = (): void => {
    for (const [ws, open] of openTasks) {
      const rows = actionLog.ofRuns(runIdsOf(open.taskId), open.cursor);
      if (rows.length === 0) continue;
      open.cursor = rows[rows.length - 1]!.id;
      const out = toLogRows(rows, redactText);
      if (out.length > 0) sendTo(ws, { type: "task.log", taskId: open.taskId, rows: out });
    }
  };
  const openTask = async (ws: WebSocket, task: Task): Promise<void> => {
    const loaded = loadProjectConfig(o.home, task.projectId);
    const root = previewRoot(o.home, task);
    const rows = actionLog.ofRuns(runIdsOf(task.id));
    openTasks.set(ws, { taskId: task.id, cursor: rows.length > 0 ? rows[rows.length - 1]!.id : 0 });
    const files = root && loaded.ok
      ? await listFiles(root, loaded.config.protectedPaths)
      : { entries: [], truncated: false, error: "folder not found" };
    const hasIndex = root !== undefined && fs.existsSync(path.join(root, "index.html"));
    sendTo(ws, { type: "task.detail", task: taskView(board.task(task.id) ?? task), log: toLogRows(rows, redactText), files, previewKey, hasIndex });
  };
  /** The diff of a task branch against the project's base branch. */
  const diffOf = (task: Task) => {
    const loaded = loadProjectConfig(o.home, task.projectId);
    const root = loaded.ok ? workDir(o.home, loaded.config, task.projectId) : undefined;
    if (!root || !task.branch) return [];
    return taskDiff(root, baseBranch(root), task.branch);
  };

  const tick = (): void => {
    if (closed) return;
    try {
      pushLogs();
    } catch (e) {
      logError(`task log error: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const { state, changed } = feed.poll();
      current = state;
      if (computeDecisions()) broadcast(lastDecisions);
      const ids = new Set(state.agents.map((a) => a.id));
      const idsDiffer = ids.size !== prevAgentIds.size || [...ids].some((id) => !prevAgentIds.has(id));
      prevAgentIds = ids;
      if (idsDiffer) {
        broadcast({ type: "snapshot", state });
        return;
      }
      const patch: ServerMsg = { type: "patch" };
      if (changed.agents.length > 0) patch.agents = changed.agents;
      if (changed.plots.length > 0) patch.plots = changed.plots;
      if (changed.approvals) patch.approvals = changed.approvals;
      if (changed.runs) patch.runs = changed.runs;
      if (patch.agents || patch.plots || patch.approvals || patch.runs) broadcast(patch);
      pollFailing = false;
    } catch (e) {
      // Skip this tick. The next poll retries. Only the first error of a streak is logged.
      if (!pollFailing) process.stderr.write(`city poll error: ${e instanceof Error ? e.message : String(e)}\n`);
      pollFailing = true;
    }
  };
  const ticker = new Ticker(tick, o.pollMs ?? 250);

  /** Sign-ins waiting for their OAuth callback, by state. */
  const signIns = new Map<string, { server: string; finish(code: string): Promise<void>; send(m: ServerMsg): void }>();
  const pushConfig = (send: (m: ServerMsg) => void): void => send({ type: "hq.config", config: hqConfig(o.home) });

  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
    if ((req.url ?? "").startsWith("/oauth/callback")) return void oauthCallback(req, res);
    if ((req.url ?? "").startsWith("/p/")) return void servePreview(req, res, { home: o.home, board, key: previewKey, port: () => port });
    const file = resolveStatic(o.staticDir, req.url ?? "/");
    if (!file) return notFound(res);
    const isIndex = path.basename(file) === "index.html";
    // The page carries the token, so only a page loaded by this exact host may see it (no DNS rebinding).
    if (isIndex && req.headers.host !== `127.0.0.1:${port}`) return notFound(res);
    fs.readFile(file, (err, raw) => {
      if (err) return notFound(res);
      const data = isIndex ? withToken(raw, token) : raw;
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        // Tells `agentcity link open` that a city already runs on this port.
        "X-Agent-City": "1",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    });
  });

  const page = (res: http.ServerResponse, status: number, text: string): void => {
    const body = `<!doctype html><meta charset="utf-8"><title>Agent City</title><p style="font:16px sans-serif">${text.replace(/[<&>]/g, "")}</p>`;
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };
  async function oauthCallback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const pending = signIns.get(u.searchParams.get("state") ?? "");
    const code = u.searchParams.get("code");
    if (!pending) return page(res, 400, "This sign-in link is old. Start it again from HQ.");
    signIns.delete(u.searchParams.get("state")!);
    if (!code) return page(res, 400, `Sign-in to ${pending.server} was cancelled: ${u.searchParams.get("error") ?? "no code"}.`);
    try {
      await pending.finish(code);
      page(res, 200, `Signed in to ${pending.server}. You can close this tab.`);
      pending.send({ type: "hq.done", id: `signin-${pending.server}`, code: 0, text: `Signed in to ${pending.server}.` });
      pushConfig(pending.send);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      page(res, 500, `Sign-in to ${pending.server} failed: ${msg}`);
      pending.send({ type: "hq.done", id: `signin-${pending.server}`, code: 1, text: `Sign-in failed: ${msg}` });
    }
  }

  let port = o.port;
  const refuse = (socket: Duplex): void => {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  };
  server.on("upgrade", (req, socket, head) => {
    let ok = false;
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      ok = u.pathname === "/ws" && u.searchParams.get("t") === token && req.headers.origin === `http://127.0.0.1:${port}`;
    } catch {
      ok = false;
    }
    if (!ok) return refuse(socket);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    const send = (m: ServerMsg): void => sendTo(ws, m);
    const term: TermHandler = o.makeTermHandler
      ? o.makeTermHandler(send)
      : (() => {
          const session = new TerminalSession({ home: o.home, providerOverride: o.providerOverride, approverFactory: approvals.factory, send, claimProject: (id) => host.claim(id) });
          return { onLine: (l) => session.line(l), close: () => session.close() };
        })();
    termHandlers.set(ws, term);
    send({ type: "snapshot", state: current });
    send(lastDecisions);
    send({ type: "session.list", sessions: sessions.list() });
    send({ type: "paused", projectIds: board.paused() });
    ws.on("message", (data) => {
      try {
        const msg = parseClientMsg(data.toString());
        if (!msg) return send({ type: "error", message: "invalid message" });
        switch (msg.type) {
          case "approve":
            if (!approvals.waiting().has(msg.id) || !approvals.answer(msg.id, msg.decision)) {
              send({ type: "error", message: "not a city approval" });
            }
            return;
          case "run": {
            if (closed) return send({ type: "error", message: "server closing" });
            const r = host.start(msg.projectId, msg.agentId, msg.goal, (m) => send({ type: "error", message: m }));
            if (!r.ok) send({ type: "error", message: r.error });
            return;
          }
          case "term.in":
            if (closed) return send({ type: "error", message: "server closing" });
            term.onLine(msg.line);
            return;
          case "models.list":
            // Config and keys are read per request, so new connections show without a restart.
            void listModels(loadGlobalConfig(o.home), readSecrets(o.home), o.fetch)
              .then((groups) => send({ type: "models", groups }))
              .catch((e: unknown) => send({ type: "error", message: e instanceof Error ? e.message : String(e) }));
            return;
          case "hq.config":
            pushConfig(send);
            return;
          case "hq.do": {
            if (closed) return send({ type: "error", message: "server closing" });
            const [a, b, name] = msg.argv;
            if (a === "mcp" && b === "signin" && name !== undefined) {
              const s = loadGlobalConfig(o.home).mcpServers.find((x) => x.name === name);
              if (!s) return send({ type: "hq.done", id: msg.id, code: 1, text: `No MCP server ${name}.` });
              const redirect = `http://127.0.0.1:${port}/oauth/callback`;
              void startMcpSignIn(o.home, s, readSecrets(o.home), redirect, (url) => send({ type: "hq.signin", server: name, url: url.toString() }))
                .then((r) => {
                  if (r.signedIn) {
                    send({ type: "hq.done", id: msg.id, code: 0, text: `${name} is already signed in.` });
                    pushConfig(send);
                  } else {
                    signIns.set(r.state, { server: name, finish: r.finish, send });
                    send({ type: "hq.done", id: msg.id, code: 0, text: `Finish the sign-in to ${name} in the new tab.` });
                  }
                })
                .catch((e: unknown) => send({ type: "hq.done", id: msg.id, code: 1, text: e instanceof Error ? e.message : String(e) }));
              return;
            }
            if (a === "project" && b === "remove" && name !== undefined) {
              // The scheduler removes the project, so its running jobs end first.
              void scheduler.forget(name)
                .then((r) => {
                  send({ type: "hq.done", id: msg.id, code: r.ok ? 0 : 1, text: r.ok ? removedText(name, r) : r.error });
                  if (!r.ok) return;
                  broadcast({ type: "hq.config", config: hqConfig(o.home) });
                  pushBoard(name);
                  if (computeDecisions()) broadcast(lastDecisions);
                })
                .catch((e: unknown) => send({ type: "hq.done", id: msg.id, code: 1, text: e instanceof Error ? e.message : String(e) }));
              return;
            }
            const removing = a === "agent" && b === "remove" && name !== undefined;
            if (removing) {
              const teams = hqConfig(o.home).projects.filter((p) => p.agents.includes(name)).map((p) => p.id);
              if (sessions.agentBusy(name, teams)) {
                const who = new AgentStore(o.home).get(name)?.name ?? name;
                return send({ type: "hq.done", id: msg.id, code: 1, text: `${who} is busy. Stop its run or wait, then remove it.` });
              }
            }
            void runHqCommand(o.home, msg.argv, msg.input, { providerOverride: o.providerOverride })
              .then((r) => {
                send({ type: "hq.done", id: msg.id, code: r.code, text: r.text });
                pushConfig(send);
                if (removing) broadcast({ type: "session.list", sessions: sessions.list() });
              })
              .catch((e: unknown) => send({ type: "hq.done", id: msg.id, code: 1, text: e instanceof Error ? e.message : String(e) }));
            return;
          }
          case "run.stop":
            if (!host.stop(msg.projectId)) send({ type: "error", message: `nothing runs in ${msg.projectId}` });
            return;
          case "hq.stats":
            send({ type: "hq.stats", stats: hqStats(db, Object.values(readSecrets(o.home))) });
            return;
          case "session.open": {
            const r = "sessionId" in msg ? sessions.open(msg.sessionId) : sessions.openPair(msg.projectId, msg.agentId);
            if (!r.ok) return send({ type: "error", message: r.error });
            send({ type: "session.thread", sessionId: r.sessionId, messages: r.messages });
            return;
          }
          case "session.new": {
            if (closed) return send({ type: "error", message: "server closing" });
            const r = sessions.create(msg.agentId, msg.projectId, { taskId: msg.taskId, goalId: msg.goalId });
            if (!r.ok) return send({ type: "error", message: r.error });
            const opened = sessions.open(r.sessionId);
            send({ type: "session.thread", sessionId: r.sessionId, messages: opened.ok ? opened.messages : [] });
            return;
          }
          case "session.send": {
            if (closed) return send({ type: "error", message: "server closing" });
            const r = "sessionId" in msg ? sessions.send(msg.sessionId, msg.text) : sessions.sendPair(msg.projectId, msg.agentId, msg.text);
            if (!r.ok) send({ type: "error", message: r.error });
            return;
          }
          case "goal.submit": {
            if (closed) return send({ type: "error", message: "server closing" });
            if (!projectOk(msg.projectId)) return send({ type: "error", message: `No project ${msg.projectId}` });
            scheduler.submitGoal(msg.projectId, msg.text);
            return;
          }
          case "board.watch": {
            if (!projectOk(msg.projectId)) return send({ type: "error", message: `No project ${msg.projectId}` });
            const set = watchers.get(ws) ?? new Set<string>();
            set.add(msg.projectId);
            watchers.set(ws, set);
            send(boardMsg(msg.projectId));
            return;
          }
          case "task.open": {
            const task = ownTask(ws, msg.taskId);
            if (!task) return send({ type: "error", message: `${msg.taskId} is not a task of a project you watch` });
            void openTask(ws, task).catch((e: unknown) => send({ type: "error", message: e instanceof Error ? e.message : String(e) }));
            return;
          }
          case "task.message":
          case "task.answer":
          case "task.action": {
            if (closed) return send({ type: "error", message: "server closing" });
            if (!(msg.type === "task.answer" ? answerableTask(ws, msg.taskId) : ownTask(ws, msg.taskId))) return send({ type: "error", message: `${msg.taskId} is not a task of a project you watch` });
            if (msg.type === "task.message") scheduler.message(msg.taskId, msg.text);
            else if (msg.type === "task.answer") scheduler.answer(msg.taskId, msg.text);
            else {
              const r = scheduler.action(msg.taskId, msg.action);
              if (!r.ok) send({ type: "error", message: r.error });
            }
            return;
          }
          case "project.pause": {
            if (closed) return send({ type: "error", message: "server closing" });
            const r = msg.paused ? scheduler.pause(msg.projectId) : scheduler.resume(msg.projectId);
            if (!r.ok) return send({ type: "error", message: r.error });
            broadcast({ type: "paused", projectIds: board.paused() });
            return;
          }
          case "city.pause": {
            if (closed) return send({ type: "error", message: "server closing" });
            if (msg.paused) scheduler.pauseAll();
            else scheduler.resumeAll();
            broadcast({ type: "paused", projectIds: board.paused() });
            return;
          }
          case "review.answer": {
            if (closed) return send({ type: "error", message: "server closing" });
            if (!answerableTask(ws, msg.taskId)) {
              return send({ type: "review.result", taskId: msg.taskId, ok: false, error: `${msg.taskId} is not a task of a project you watch` });
            }
            const r = scheduler.review(msg.taskId, msg.option, msg.text);
            send({ type: "review.result", taskId: msg.taskId, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
            return;
          }
          case "plan.answer": {
            if (closed) return send({ type: "error", message: "server closing" });
            const goal = board.goal(msg.goalId);
            if (!goal || !(watchers.get(ws)?.has(goal.projectId) || listed("goalId", goal.id))) {
              return send({ type: "plan.result", goalId: msg.goalId, ok: false, error: `${msg.goalId} is not a goal of a project you watch` });
            }
            const r = scheduler.answerPlan(msg.goalId, msg.option, msg.text);
            send({ type: "plan.result", goalId: msg.goalId, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
            return;
          }
          case "diff.request": {
            const task = answerableTask(ws, msg.taskId);
            if (!task) return send({ type: "error", message: `${msg.taskId} is not a task of a project you watch` });
            send({ type: "diff", taskId: task.id, files: diffOf(task) });
            return;
          }
          case "file.request": {
            const task = ownTask(ws, msg.taskId);
            if (!task) return send({ type: "error", message: `${msg.taskId} is not a task of a project you watch` });
            const loaded = loadProjectConfig(o.home, task.projectId);
            const root = previewRoot(o.home, task);
            const reply = (f: ProjectFile) => send({ type: "file", taskId: task.id, path: msg.path, ...f });
            if (!root || !loaded.ok) return reply({ binary: false, truncated: false, error: "folder not found" });
            void readProjectFile(root, msg.path, loaded.config.protectedPaths).then(reply);
            return;
          }
          case "ports.scan":
            void scanPorts([port]).then((list) => send({ type: "ports", list }));
            return;
          case "agent.model": {
            if (!agents.get(msg.agentId)) return send({ type: "error", message: `No agent ${msg.agentId}` });
            const r = parseModelId(msg.model, loadGlobalConfig(o.home).connections.map((c) => c.name));
            if (!r.ok) return send({ type: "error", message: r.error });
            const p = agents.update(msg.agentId, { model: msg.model });
            send({ type: "agent.saved", agentId: p.id, version: p.version });
            return;
          }
        }
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
      watchers.delete(ws);
      openTasks.delete(ws);
      termHandlers.get(ws)?.close();
      termHandlers.delete(ws);
    });
    ws.on("error", () => ws.terminate());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => {
      db.close();
      reject(e);
    };
    server.once("error", onError);
    server.listen(o.port, "127.0.0.1", () => {
      server.off("error", onError);
      server.on("error", (e: Error) => void process.stderr.write(`city server error: ${e.message}\n`));
      resolve();
    });
  });
  port = (server.address() as { port: number }).port;
  writeCityLock(o.home, port);
  // Tasks a crash left in doing go back to todo, then the board runs on its 5 second tick.
  try {
    scheduler.recover();
  } catch (e) {
    logError(`board recover error: ${e instanceof Error ? e.message : String(e)}`);
  }
  scheduler.start();
  ticker.start();

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    token,
    async close() {
      if (closed) return;
      closed = true;
      removeCityLock(o.home, port);
      ticker.stop();
      scheduler.stop();
      sessions.stop();
      await host.stopAll();
      // Aborted board jobs and chat turns end quickly. A job stuck past 2 s is left behind.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([scheduler.whenIdle(), sessions.whenIdle()]),
        new Promise<void>((r) => (timer = setTimeout(r, 2000))),
      ]);
      clearTimeout(timer);
      watchers.clear();
      openTasks.clear();
      for (const t of termHandlers.values()) t.close();
      termHandlers.clear();
      for (const ws of clients) ws.terminate();
      clients.clear();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      if (db.open) db.close();
    },
  };
}
