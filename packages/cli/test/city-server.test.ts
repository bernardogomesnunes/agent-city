import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { FakeProvider, type ChatResponse, type Provider } from "@agentcity/core";
import { ActionLog, BoardStore, SessionStore, loadProjectConfig, openDb, projectDirs, saveProjectConfig } from "@agentcity/safety";
import { AgentStore } from "@agentcity/org";
import type { ServerMsg } from "@agentcity/world/shared";
import { runCli } from "../src/wire.js";
import { startCityServer, type CityServer } from "../src/city-server.js";
import { taskContext } from "../src/task-log.js";

const usage = { inputTokens: 1, outputTokens: 1 };
const call = (id: string, name: string, args: unknown): ChatResponse => ({ text: "", toolCalls: [{ id, name, args }], usage });
const say = (text: string): ChatResponse => ({ text, toolCalls: [], usage });
const send = (id: string) => call(id, "send_message", { to: "x", body: "hi" });

let home: string;
let staticDir: string;
let servers: CityServer[];
let sockets: WebSocket[];

const waitFor = async (pred: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 10 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(pred()).toBe(true);
};
const start = async (script: ChatResponse[] = [], pollMs = 50) => {
  const s = await startCityServer({ home, port: 0, staticDir, pollMs, providerOverride: new FakeProvider(script) });
  servers.push(s);
  return s;
};
const wsUrl = (s: CityServer, token = s.token) => `ws://127.0.0.1:${s.port}/ws?t=${token}`;
const connect = async (s: CityServer) => {
  const ws = new WebSocket(wsUrl(s), { origin: `http://127.0.0.1:${s.port}` });
  sockets.push(ws);
  const msgs: ServerMsg[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as ServerMsg));
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  return { ws, msgs };
};
const rejectedStatus = (url: string, origin: string) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(url, { origin });
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("open", () => resolve(101));
    ws.once("error", () => undefined);
  });
const get = (s: CityServer, p: string) =>
  new Promise<{ status: number; type?: string; body: string }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: s.port, path: p }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body }));
      })
      .on("error", reject);
  });
const io = () => ({ input: new PassThrough(), output: new PassThrough(), error: new PassThrough() });
const text = (s: PassThrough) => (s.read() as Buffer | null)?.toString() ?? "";
const outbox = () => fs.readdirSync(projectDirs(home, "demo").outbox).length;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-city-"));
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-static-"));
  fs.writeFileSync(path.join(staticDir, "index.html"), "<html>city</html>");
  fs.writeFileSync(path.join(staticDir, "app.js"), "1");
  servers = [];
  sockets = [];
  const i = io();
  expect(await runCli(["init", "demo"], { home, io: i })).toBe(0);
  expect(await runCli(["agent", "create", "ada", "--name", "Ada", "--model", "lmstudio/test", "--persona", "You are Ada."], { home, io: i })).toBe(0);
  expect(await runCli(["grant", "demo", "ada"], { home, io: i })).toBe(0);
});
afterEach(async () => {
  for (const ws of sockets) ws.terminate();
  for (const s of servers) await s.close();
});

describe("city lock", () => {
  it("the city writes its pid and port to the home on start and removes the file on close", async () => {
    const s = await start();
    const lock = path.join(home, "city.lock");
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toEqual({ pid: process.pid, port: s.port });
    await s.close();
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("city lock refusal", () => {
  it("a second city on the same home refuses to start and names the port of the first", async () => {
    const s = await start();
    await expect(startCityServer({ home, port: 0, staticDir })).rejects.toThrow(`a city already runs on this home (port ${s.port})`);
    expect(JSON.parse(fs.readFileSync(path.join(home, "city.lock"), "utf8"))).toEqual({ pid: process.pid, port: s.port });
  });

  it("a stale lock does not stop a start", async () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    fs.writeFileSync(path.join(home, "city.lock"), JSON.stringify({ pid: dead.pid, port: 5999 }));
    const s = await start();
    expect(JSON.parse(fs.readFileSync(path.join(home, "city.lock"), "utf8"))).toEqual({ pid: process.pid, port: s.port });
  });
});

describe("city server http", () => {
  it("serves index and files with content types", async () => {
    const s = await start();
    const root = await get(s, "/?t=whatever");
    expect(root.status).toBe(200);
    expect(root.type).toContain("text/html");
    expect(root.body).toBe("<html>city</html>");
    const js = await get(s, "/app.js");
    expect(js.type).toContain("text/javascript");
  });

  it("puts the token in the page, only for the 127.0.0.1 host", async () => {
    fs.writeFileSync(path.join(staticDir, "index.html"), "<html><head></head>city</html>");
    const s = await start();
    expect((await get(s, "/")).body).toBe(`<html><head><meta name="agentcity-token" content="${s.token}"></head>city</html>`);
    const rebound = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: s.port, path: "/", headers: { host: `evil.test:${s.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    expect(rebound).toBe(404);
  });

  it("rejects traversal with 404", async () => {
    const s = await start();
    expect((await get(s, "/../package.json")).status).toBe(404);
    expect((await get(s, "/%2e%2e/x")).status).toBe(404);
    expect((await get(s, "/..%2f..%2fpackage.json")).status).toBe(404);
    expect((await get(s, "/missing.js")).status).toBe(404);
  });
});

describe("city server websocket", () => {
  it("refuses a wrong token and a wrong origin with 403", async () => {
    const s = await start();
    expect(await rejectedStatus(wsUrl(s, "bad"), `http://127.0.0.1:${s.port}`)).toBe(403);
    expect(await rejectedStatus(wsUrl(s), "http://evil.example")).toBe(403);
    expect(await rejectedStatus(`ws://127.0.0.1:${s.port}/other?t=${s.token}`, `http://127.0.0.1:${s.port}`)).toBe(403);
  });

  it("sends a snapshot with created agents on connect", async () => {
    const s = await start();
    const { msgs } = await connect(s);
    await waitFor(() => msgs.length > 0);
    const m = msgs[0]!;
    expect(m.type).toBe("snapshot");
    if (m.type === "snapshot") expect(m.state.agents.map((a) => a.id)).toEqual(["ada"]);
  });

  it("sends a patch to two clients within 1 s of a new action row", async () => {
    const s = await start();
    const a = await connect(s);
    const b = await connect(s);
    await waitFor(() => a.msgs.length > 0 && b.msgs.length > 0);
    const db = openDb(home);
    new ActionLog(db, []).append({ projectId: "demo", agentId: "ada", runId: "r1", type: "tool.requested", payload: { call: { name: "read_file", args: { path: "a" } } } });
    db.close();
    const patched = (m: ServerMsg[]) => m.some((x) => x.type === "patch" && x.agents?.some((v) => v.id === "ada"));
    await waitFor(() => patched(a.msgs) && patched(b.msgs), 1000);
  });

  it("sends a snapshot instead of a patch when an agent is created", async () => {
    const s = await start();
    const a = await connect(s);
    await waitFor(() => a.msgs.length > 0);
    expect(await runCli(["agent", "create", "bob", "--name", "Bob", "--model", "lmstudio/test", "--persona", "p"], { home, io: io() })).toBe(0);
    await waitFor(() => a.msgs.some((m, i) => i > 0 && m.type === "snapshot" && m.state.agents.some((v) => v.id === "bob")));
  });

  it("answers approve for an unknown id with an error", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "approve", id: 999, decision: "approved" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message === "not a city approval"));
  });

  it("answers models.list", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "models.list" }));
    await waitFor(() => a.msgs.some((m) => m.type === "models"), 5000);
    const m = a.msgs.find((x) => x.type === "models");
    expect(m?.type === "models" && m.groups[0]).toMatchObject({ label: "Claude subscription", models: ["claude-sub/sonnet", "claude-sub/opus", "claude-sub/haiku"] });
  });

  it("agent.model saves a new version, replies agent.saved and patches the view", async () => {
    const s = await start();
    const a = await connect(s);
    await waitFor(() => a.msgs.some((m) => m.type === "snapshot"));
    const snap = a.msgs.find((m) => m.type === "snapshot");
    expect(snap?.type === "snapshot" && snap.state.agents[0]!.model).toBe("lmstudio/test");
    a.ws.send(JSON.stringify({ type: "agent.model", agentId: "ada", model: "claude-sub/haiku" }));
    await waitFor(() => a.msgs.some((m) => m.type === "agent.saved" && m.agentId === "ada" && m.version === 2));
    expect(new AgentStore(home).get("ada")!.model).toBe("claude-sub/haiku");
    await waitFor(() => a.msgs.some((m) => m.type === "patch" && m.agents?.some((v) => v.id === "ada" && v.model === "claude-sub/haiku")));
  });

  it("agent.model with a bad id or a missing agent replies error and saves nothing", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "agent.model", agentId: "ada", model: "gpt-4o" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message.startsWith("unknown model gpt-4o")));
    a.ws.send(JSON.stringify({ type: "agent.model", agentId: "ghost", model: "claude-sub/haiku" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message === "No agent ghost"));
    expect(new AgentStore(home).get("ada")!.version).toBe(1);
  });

  it("answers invalid json with an error", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send("nope");
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message === "invalid message"));
  });

  it("runs term.in lines in the default terminal session", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "term.in", line: "agent list" }));
    await waitFor(() => a.msgs.some((m) => m.type === "term.done" && m.code === 0));
    expect(a.msgs.some((m) => m.type === "term.out" && m.text.includes("ada	Ada"))).toBe(true);
    a.ws.send(JSON.stringify({ type: "term.in", line: "city" }));
    await waitFor(() => a.msgs.some((m) => m.type === "term.done" && m.code === 1));
  });

  it("survives a poll that throws and patches on the next tick", async () => {
    const s = await start();
    const a = await connect(s);
    const quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spy = vi.spyOn(AgentStore.prototype, "list").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await waitFor(() => spy.mock.calls.length >= 1);
    spy.mockRestore();
    quiet.mockRestore();
    const i = io();
    expect(await runCli(["agent", "create", "bob", "--name", "Bob", "--persona", "You are Bob."], { home, io: i })).toBe(0);
    await waitFor(() => a.msgs.some((m) => m.type === "snapshot" && m.state.agents.some((x) => x.id === "bob")));
  });

  it("a run started by client A is approved by client B", async () => {
    const s = await start([send("1"), say("done")]);
    const a = await connect(s);
    const b = await connect(s);
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    const pending = () => {
      for (const m of [...b.msgs].reverse()) if (m.type === "patch" && m.approvals) return m.approvals;
      return [];
    };
    await waitFor(() => pending().some((p) => p.local));
    const id = pending()[0]!.id;
    expect(outbox()).toBe(0);
    b.ws.send(JSON.stringify({ type: "approve", id, decision: "approved" }));
    await waitFor(() => outbox() === 1);
    await waitFor(() => pending().length === 0);
    await waitFor(() => a.msgs.some((m) => m.type === "patch" && m.approvals?.length === 0));
  });

  it("a connection added after the city starts works for an HQ run", async () => {
    const s = await start([say("done")]);
    const a = await connect(s);
    const i = io();
    expect(await runCli(["connection", "add", "late", "https://l/v1", "--input-price", "0", "--output-price", "0"], { home, io: i })).toBe(0);
    a.ws.send(JSON.stringify({ type: "agent.model", agentId: "ada", model: "api/late/m" }));
    await waitFor(() => a.msgs.some((m) => m.type === "agent.saved"));
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    const db = openDb(home);
    try {
      await waitFor(() => new ActionLog(db, []).list("demo").some((r) => r.type === "run.stopped" && (r.payload as { reason?: string }).reason === "done"));
    } finally {
      db.close();
    }
    expect(a.msgs.some((m) => m.type === "error")).toBe(false);
  });

  it("an HQ run whose connection is gone reports the reason to the client", async () => {
    const s = await start([say("done")]);
    const a = await connect(s);
    const i = io();
    await runCli(["connection", "add", "gone", "https://g/v1", "--input-price", "0", "--output-price", "0"], { home, io: i });
    await runCli(["agent", "edit", "ada", "--model", "api/gone/m"], { home, io: i });
    await runCli(["connection", "remove", "gone"], { home, io: i });
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message.includes("No connection gone")));
  });

  it("a second run on a busy project gets project busy", async () => {
    const s = await start([send("1"), say("done")]);
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "again" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message === "project busy"));
  });

  it("a terminal run on a project busy with an HQ run gets project busy", async () => {
    const s = await start([send("1"), say("done")]);
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    await waitFor(() => a.msgs.some((m) => m.type === "patch" && (m.approvals?.length ?? 0) > 0));
    a.ws.send(JSON.stringify({ type: "term.in", line: "run demo again --agent ada" }));
    await waitFor(() => a.msgs.some((m) => m.type === "term.done" && m.code === 1));
    expect(a.msgs.some((m) => m.type === "term.out" && m.text.includes("project busy"))).toBe(true);
  });

  it("refuses secrets in the city terminal", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "term.in", line: "secrets set openai" }));
    await waitFor(() => a.msgs.some((m) => m.type === "term.done" && m.code === 1));
    expect(a.msgs.some((m) => m.type === "term.out" && m.text.includes("secrets cannot be set from the city"))).toBe(true);
  });

  it("after close() starts, run and term.in start nothing", async () => {
    const hang = { id: "hang", chat: () => new Promise<ChatResponse>(() => undefined) };
    const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: hang });
    servers.push(s);
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    await new Promise((r) => setTimeout(r, 100));
    const closing = s.close(); // waits up to 2000 ms for the hung run
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "again" }));
    a.ws.send(JSON.stringify({ type: "term.in", line: "agent list" }));
    await waitFor(() => a.msgs.filter((m) => m.type === "error" && m.message === "server closing").length === 2);
    expect(a.msgs.some((m) => m.type === "term.out")).toBe(false);
    await closing;
  });

  it("a throwing handler replies with an error and the server keeps working", async () => {
    const s = await start();
    const a = await connect(s);
    const spy = vi.spyOn(AgentStore.prototype, "get").mockImplementationOnce(() => {
      throw new Error("store exploded");
    });
    a.ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message === "store exploded"));
    spy.mockRestore();
    a.ws.send(JSON.stringify({ type: "term.in", line: "agent list" }));
    await waitFor(() => a.msgs.some((m) => m.type === "term.done" && m.code === 0));
  });

  it("logs the first poll error of a failure streak to stderr", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await start();
    const list = vi.spyOn(AgentStore.prototype, "list").mockImplementation(() => {
      throw new Error("poll boom");
    });
    await waitFor(() => list.mock.calls.length >= 4);
    const logged = err.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("city poll error: poll boom"));
    list.mockRestore();
    err.mockRestore();
    expect(logged).toHaveLength(1);
  });

  it("calls the term hook per client when provided", async () => {
    const lines: string[] = [];
    const s = await startCityServer({
      home, port: 0, staticDir, pollMs: 50,
      makeTermHandler: (reply) => ({ onLine: (l) => { lines.push(l); reply({ type: "term.done", code: 0 }); }, close: () => undefined }),
    });
    servers.push(s);
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "term.in", line: "agent list" }));
    await waitFor(() => lines.length === 1);
    await waitFor(() => a.msgs.some((m) => m.type === "term.done"));
  });
});

describe("city sessions", () => {
  const thread = (msgs: ServerMsg[]) =>
    msgs.flatMap((m) => (m.type === "session.msg" ? [m.message] : []))
      // A message is sent again each time it changes; keep the last copy.
      .reduce((acc, m) => acc.set(m.id, m), new Map<number, { kind: string; text: string; status: string; author: string; sessionId: number }>());
  const lastList = (msgs: ServerMsg[]) => {
    const m = [...msgs].reverse().find((x) => x.type === "session.list");
    return m?.type === "session.list" ? m.sessions : [];
  };
  const json = (o: unknown) => JSON.stringify(o);

  it("runs a message, stores the answer, queues the next and gives it the history", async () => {
    const provider = new FakeProvider([say("menu built"), say("colours changed")]);
    const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: provider });
    servers.push(s);
    const a = await connect(s);
    const b = await connect(s);
    a.ws.send(json({ type: "session.send", projectId: "demo", agentId: "ada", text: "build the menu" }));
    a.ws.send(json({ type: "session.send", projectId: "demo", agentId: "ada", text: "now change the colours" }));
    await waitFor(() => [...thread(b.msgs).values()].filter((m) => m.kind === "agent").length === 2);
    const rows = [...thread(b.msgs).values()].map((m) => [m.kind, m.text, m.status]);
    expect(rows).toEqual([
      ["user", "build the menu", "done"],
      ["user", "now change the colours", "done"],
      ["agent", "menu built", "done"],
      ["agent", "colours changed", "done"],
    ]);
    // The second turn sees the first message and answer, no tool calls.
    const second = provider.requests[1]!.messages.map((m) => [m.role, m.content]);
    expect(second.slice(1)).toEqual([["user", "build the menu"], ["assistant", "menu built"], ["user", "now change the colours"]]);
    // A chat offers read tools and remember, never a write or command tool.
    const names = provider.requests[0]!.tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_files", "read_file", "remember", "search_files"]);
    await waitFor(() => lastList(b.msgs)[0]?.status === "idle" && lastList(b.msgs)[0]!.last.includes("colours changed"));
    expect(lastList(b.msgs)[0]!.title).toBe("build the menu");
    a.ws.send(json({ type: "session.open", projectId: "demo", agentId: "ada" }));
    await waitFor(() => a.msgs.some((m) => m.type === "session.thread" && m.messages.length === 4));
  });

  it("session.new makes separate chats of one pair and a chat without a project", async () => {
    const provider = new FakeProvider([say("one"), say("two"), say("three")]);
    const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: provider });
    servers.push(s);
    const a = await connect(s);
    a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "demo" }));
    a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "demo" }));
    a.ws.send(json({ type: "session.new", agentId: "ada" }));
    await waitFor(() => lastList(a.msgs).length === 3);
    const [first, second, bare] = lastList(a.msgs);
    expect(new Set([first!.id, second!.id, bare!.id]).size).toBe(3);
    expect(bare!.projectId).toBeUndefined();
    expect(first!.projectId).toBe("demo");
    a.ws.send(json({ type: "session.send", sessionId: second!.id, text: "hello from the second chat that is longer than forty characters" }));
    a.ws.send(json({ type: "session.send", sessionId: bare!.id, text: "no project here" }));
    await waitFor(() => [...thread(a.msgs).values()].filter((m) => m.kind === "agent").length === 2);
    const byChat = (id: number) => [...thread(a.msgs).values()].filter((m) => m.sessionId === id).map((m) => [m.kind, m.text]);
    expect(byChat(second!.id)).toEqual([["user", "hello from the second chat that is longer than forty characters"], ["agent", "one"]]);
    expect(byChat(bare!.id)).toEqual([["user", "no project here"], ["agent", "two"]]);
    expect(byChat(first!.id)).toEqual([]);
    expect(lastList(a.msgs).find((x) => x.id === second!.id)!.title).toBe("hello from the second chat that is longer"
      .slice(0, 40));
    // The chat without a project works in a scratch folder under the home and has only remember.
    expect(fs.existsSync(path.join(home, "chats", String(bare!.id)))).toBe(true);
    expect(provider.requests[1]!.tools.map((t) => t.name)).toEqual(["remember"]);
    a.ws.send(json({ type: "session.open", sessionId: second!.id }));
    await waitFor(() => a.msgs.some((m) => m.type === "session.thread" && m.sessionId === second!.id && m.messages.length === 2));
  });

  describe("chats about a task or goal", () => {
    const seed = () => {
      const db = openDb(home);
      const board = new BoardStore(db);
      const g = board.createGoal("demo", "make the menu");
      const team = board.createTask({ goalId: g.id, title: "team", description: "d", assignee: "ada", createdBy: "ada" });
      const t = board.createTask({ goalId: g.id, parentId: team.id, title: "Fix broken index.html", description: "the page is blank", assignee: "ada", createdBy: "ada" });
      // Held, so the scheduler leaves the tasks as seeded.
      board.setHeld(team.id, true);
      board.setHeld(t.id, true);
      db.close();
      return { goalId: g.id, taskId: t.id };
    };
    const opened = (msgs: ServerMsg[]) => {
      const m = [...msgs].reverse().find((x) => x.type === "session.thread");
      return m?.type === "session.thread" ? m : undefined;
    };

    it("session.new with taskId titles the chat with the task title", async () => {
      const { taskId } = seed();
      const s = await start();
      const a = await connect(s);
      a.ws.send(json({ type: "session.new", agentId: "ada", taskId }));
      await waitFor(() => lastList(a.msgs).length === 1);
      expect(lastList(a.msgs)[0]!.title).toBe("Fix broken index.html");
      expect(lastList(a.msgs)[0]!.projectId).toBe("demo");
    });

    it("the session list carries the taskId and goalId of a chat, and null for a plain chat", async () => {
      const { goalId, taskId } = seed();
      const s = await start();
      const a = await connect(s);
      a.ws.send(json({ type: "session.new", agentId: "ada", taskId }));
      await waitFor(() => lastList(a.msgs).length === 1);
      a.ws.send(json({ type: "session.new", agentId: "ada", goalId }));
      await waitFor(() => lastList(a.msgs).length === 2);
      a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "demo" }));
      await waitFor(() => lastList(a.msgs).length === 3);
      expect(lastList(a.msgs).map((x) => [x.taskId, x.goalId])).toEqual([[taskId, null], [null, goalId], [null, null]]);
    });

    it("session.new with a taskId or goalId uses the project of that task or goal, not the one the client sent", async () => {
      const { goalId, taskId } = seed();
      expect(await runCli(["init", "other"], { home, io: io() })).toBe(0);
      expect(await runCli(["grant", "other", "ada"], { home, io: io() })).toBe(0);
      const s = await start();
      const a = await connect(s);
      a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "other", taskId }));
      await waitFor(() => lastList(a.msgs).length === 1);
      a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "other", goalId }));
      await waitFor(() => lastList(a.msgs).length === 2);
      expect(lastList(a.msgs).map((x) => x.projectId)).toEqual(["demo", "demo"]);
    });

    it("the first turn is found even when the first player message is older than the last 200 rows", async () => {
      const { taskId } = seed();
      const provider = new FakeProvider([say("ok")]);
      const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: provider });
      servers.push(s);
      const a = await connect(s);
      a.ws.send(json({ type: "session.new", agentId: "ada", taskId }));
      await waitFor(() => lastList(a.msgs).length === 1);
      const id = lastList(a.msgs)[0]!.id;
      const db = openDb(home);
      const store = new SessionStore(db, []);
      store.append(id, { kind: "user", author: "you", text: "first" });
      for (let i = 0; i < 250; i++) store.append(id, { kind: "system", author: "city", text: `row ${i}` });
      db.close();
      a.ws.send(json({ type: "session.send", sessionId: id, text: "again" }));
      await waitFor(() => provider.requests.length === 1);
      expect(provider.requests[0]!.messages.at(-1)!.content).toBe("again");
    });

    it("first turn of a task chat carries the context, the second does not", async () => {
      const { taskId } = seed();
      const provider = new FakeProvider([say("looking"), say("ok")]);
      const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: provider });
      servers.push(s);
      const a = await connect(s);
      a.ws.send(json({ type: "session.new", agentId: "ada", taskId }));
      await waitFor(() => lastList(a.msgs).length === 1);
      const id = lastList(a.msgs)[0]!.id;
      a.ws.send(json({ type: "session.send", sessionId: id, text: "why is it blank?" }));
      await waitFor(() => [...thread(a.msgs).values()].some((m) => m.kind === "agent" && m.text === "looking"));
      const db = openDb(home);
      const task = new BoardStore(db).task(taskId)!;
      db.close();
      const first = provider.requests[0]!.messages.at(-1)!.content as string;
      expect(first).toBe(`${taskContext(task, [], (x) => x)}\n\nwhy is it blank?`);
      expect(first.startsWith("This chat is about task ")).toBe(true);
      a.ws.send(json({ type: "session.send", sessionId: id, text: "and now?" }));
      await waitFor(() => [...thread(a.msgs).values()].some((m) => m.kind === "agent" && m.text === "ok"));
      expect(provider.requests[1]!.messages.at(-1)!.content).toBe("and now?");
    });

    it("session.new with goalId titles it with the goal text and the first turn lists the tasks", async () => {
      const { goalId } = seed();
      const provider = new FakeProvider([say("hi")]);
      const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: provider });
      servers.push(s);
      const a = await connect(s);
      a.ws.send(json({ type: "session.new", agentId: "ada", goalId }));
      await waitFor(() => lastList(a.msgs).length === 1);
      expect(lastList(a.msgs)[0]!.title).toBe("make the menu");
      a.ws.send(json({ type: "session.send", sessionId: lastList(a.msgs)[0]!.id, text: "status?" }));
      await waitFor(() => provider.requests.length === 1);
      const prompt = provider.requests[0]!.messages.at(-1)!.content as string;
      expect(prompt).toContain("This chat is about goal " + goalId + ": make the menu");
      expect(prompt).toContain("Fix broken index.html (todo)");
      expect(prompt.endsWith("\n\nstatus?")).toBe(true);
    });

    it("session.new for a removed agent opens the goal's Manager and says so", async () => {
      const i = io();
      expect(await runCli(["agent", "create", "mia", "--name", "Mia", "--role", "manager", "--model", "lmstudio/test", "--persona", "You manage."], { home, io: i })).toBe(0);
      expect(await runCli(["grant", "demo", "mia"], { home, io: i })).toBe(0);
      const db = openDb(home);
      const board = new BoardStore(db);
      const g = board.createGoal("demo", "make the menu");
      board.createTask({ goalId: g.id, title: "team", description: "d", assignee: "ada", createdBy: "mia" });
      db.close();
      const s = await start();
      const a = await connect(s);
      a.ws.send(json({ type: "session.new", agentId: "ghost", goalId: g.id }));
      await waitFor(() => opened(a.msgs) !== undefined);
      const lines = opened(a.msgs)!.messages;
      expect(lines[0]!.kind).toBe("system");
      expect(lines[0]!.text).toContain("Mia");
      expect(lastList(a.msgs)[0]!.agentId).toBe("mia");
    });

    it("send to a chat whose task is gone says so", async () => {
      const { taskId } = seed();
      const provider = new FakeProvider([say("never")]);
      const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: provider });
      servers.push(s);
      const a = await connect(s);
      a.ws.send(json({ type: "session.new", agentId: "ada", taskId }));
      await waitFor(() => lastList(a.msgs).length === 1);
      const db = openDb(home);
      new BoardStore(db).deleteProject("demo");
      db.close();
      a.ws.send(json({ type: "session.send", sessionId: lastList(a.msgs)[0]!.id, text: "hello?" }));
      await waitFor(() => [...thread(a.msgs).values()].some((m) => m.kind === "system" && m.text === "the task is gone"));
      expect(provider.requests).toHaveLength(0);
    });
  });

  it("refuses an unknown agent, project and chat, and stores nothing", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "session.send", projectId: "demo", agentId: "ghost", text: "hi" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message === "No agent ghost"));
    a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "../bad" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message === "No project ../bad"));
    a.ws.send(json({ type: "session.send", sessionId: 999, text: "hi" }));
    await waitFor(() => a.msgs.some((m) => m.type === "error" && m.message === "No chat 999"));
    a.ws.send(json({ type: "session.open", sessionId: 999 }));
    await waitFor(() => a.msgs.filter((m) => m.type === "error" && m.message === "No chat 999").length === 2);
    expect(thread(a.msgs).size).toBe(0);
  });

  it("a chat does not wait for a project that another run holds", async () => {
    const s = await start([send("1"), say("chat answer"), say("run done")]);
    const a = await connect(s);
    a.ws.send(json({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    await waitFor(() => a.msgs.some((m) => m.type === "patch" && m.approvals?.some((p) => p.local)));
    a.ws.send(json({ type: "session.send", projectId: "demo", agentId: "ada", text: "while that runs" }));
    await waitFor(() => [...thread(a.msgs).values()].some((m) => m.kind === "agent" && m.text === "chat answer"));
    const pending = [...a.msgs].reverse().find((m) => m.type === "patch" && m.approvals)!;
    a.ws.send(json({ type: "approve", id: pending.type === "patch" ? pending.approvals![0]!.id : 0, decision: "approved" }));
  });

  it("chats of one agent run one at a time", async () => {
    const gate = new Blocking();
    const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: gate });
    servers.push(s);
    const a = await connect(s);
    a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "demo" }));
    a.ws.send(json({ type: "session.new", agentId: "ada" }));
    await waitFor(() => lastList(a.msgs).length === 2);
    const [one, two] = lastList(a.msgs);
    a.ws.send(json({ type: "session.send", sessionId: one!.id, text: "first" }));
    a.ws.send(json({ type: "session.send", sessionId: two!.id, text: "second" }));
    await waitFor(() => lastList(a.msgs).find((x) => x.id === one!.id)?.status === "working");
    await waitFor(() => lastList(a.msgs).find((x) => x.id === two!.id)?.status === "waiting");
    expect(gate.calls).toBe(1);
    gate.open();
    await waitFor(() => [...thread(a.msgs).values()].filter((m) => m.kind === "agent").length === 2);
    expect(gate.calls).toBe(2);
  });

  it("refuses to remove a busy agent, then removes it and drops its chats from the list", async () => {
    const s = await start([send("1"), say("done")]);
    const a = await connect(s);
    a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "demo" }));
    await waitFor(() => lastList(a.msgs).length === 1);
    a.ws.send(json({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    await waitFor(() => a.msgs.some((m) => m.type === "patch" && m.approvals?.some((p) => p.local)));
    a.ws.send(json({ type: "hq.do", id: "rm1", argv: ["agent", "remove", "ada"] }));
    await waitFor(() => a.msgs.some((m) => m.type === "hq.done" && m.id === "rm1"));
    const refused = a.msgs.find((m) => m.type === "hq.done" && m.id === "rm1");
    expect(refused?.type === "hq.done" && [refused.code, refused.text]).toEqual([1, "Ada is busy. Stop its run or wait, then remove it."]);
    const pending = [...a.msgs].reverse().find((m) => m.type === "patch" && m.approvals)!;
    a.ws.send(json({ type: "approve", id: pending.type === "patch" ? pending.approvals![0]!.id : 0, decision: "approved" }));
    await waitFor(() => a.msgs.some((m) => m.type === "patch" && m.runs && m.runs.length === 0));
    a.ws.send(json({ type: "hq.do", id: "rm2", argv: ["agent", "remove", "ada"] }));
    await waitFor(() => a.msgs.some((m) => m.type === "hq.done" && m.id === "rm2" && m.code === 0));
    await waitFor(() => lastList(a.msgs).length === 0);
  });
});

/** Answers after `open()`. Counts the calls. */
class Blocking implements Provider {
  id = "blocking";
  calls = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((r) => (this.release = r));
  open(): void {
    this.release();
  }
  async chat(): Promise<ChatResponse> {
    this.calls++;
    await this.gate;
    return say("ok");
  }
}

describe("city board", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  const json = (o: unknown) => JSON.stringify(o);
  const boards = (msgs: ServerMsg[]) => msgs.flatMap((m) => (m.type === "board" ? [m] : []));
  const lastBoard = (msgs: ServerMsg[], project = "demo") => boards(msgs).filter((b) => b.projectId === project).at(-1);
  const results = (msgs: ServerMsg[]) => msgs.flatMap((m) => (m.type === "review.result" ? [m] : []));
  const errors = (msgs: ServerMsg[]) => msgs.flatMap((m) => (m.type === "error" ? [m.message] : []));

  /** Gives the project demo a linked git repo with one commit. */
  const linkRepo = async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ac-city-repo-"));
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const r = loadProjectConfig(home, "demo");
    if (!r.ok) throw new Error(r.error);
    saveProjectConfig(home, { ...r.config, workspace: repo });
  };
  const seed = () => {
    const db = openDb(home);
    const board = new BoardStore(db);
    return { db, board };
  };
  /** A goal with a team task t1 and a worker task t2 waiting for approval on branch agent/ada/t2. */
  const approvalTask = (board: BoardStore, project = "demo") => {
    const g = board.createGoal(project, "make it");
    const team = board.createTask({ goalId: g.id, title: "team", description: "d", assignee: "ada", createdBy: "ada" });
    const t = board.createTask({ goalId: g.id, parentId: team.id, title: "work", description: "d", assignee: "ada", createdBy: "ada" });
    board.setStatus(t.id, "doing");
    board.setStatus(t.id, "review");
    board.setStatus(t.id, "approval");
    board.update(t.id, { branch: `agent/ada/${t.id}` });
    return board.task(t.id)!;
  };
  const makeOther = async () => {
    const i = io();
    expect(await runCli(["init", "other"], { home, io: i })).toBe(0);
    expect(await runCli(["grant", "other", "ada"], { home, io: i })).toBe(0);
  };

  afterEach(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
  });

  it("goal.submit creates g1 and broadcasts board to the clients watching the project", async () => {
    const s = await start();
    const a = await connect(s);
    const b = await connect(s);
    const c = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    b.ws.send(json({ type: "board.watch", projectId: "demo" }));
    await waitFor(() => boards(a.msgs).length > 0 && boards(b.msgs).length > 0);
    expect(boards(a.msgs)[0]).toMatchObject({ projectId: "demo", goals: [], tasks: [] });
    c.ws.send(json({ type: "goal.submit", projectId: "demo", text: "make pong" }));
    await waitFor(() => lastBoard(a.msgs)?.goals.some((g) => g.id === "g1") === true);
    await waitFor(() => lastBoard(b.msgs)?.goals.some((g) => g.id === "g1") === true);
    expect(lastBoard(a.msgs)!.goals[0]).toMatchObject({ id: "g1", text: "make pong", done: 0, total: 0 });
    // c never watched, so it gets no board message
    expect(boards(c.msgs)).toEqual([]);
  });

  it("a bad project id returns an error message and the socket stays open", async () => {
    const s = await start();
    const a = await connect(s);
    for (const m of [
      { type: "goal.submit", projectId: "../bad", text: "x" },
      { type: "board.watch", projectId: "nope" },
      { type: "session.new", agentId: "ada", projectId: "NOPE" },
    ]) a.ws.send(json(m));
    await waitFor(() => errors(a.msgs).length === 3);
    expect(errors(a.msgs)).toEqual(["No project ../bad", "No project nope", "No project NOPE"]);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    await waitFor(() => boards(a.msgs).length === 1);
  });

  it("task.open returns the task with its log, files and a preview key, and refuses a task of an unwatched project", async () => {
    await makeOther();
    const { db, board } = seed();
    const t = approvalTask(board, "other");
    const mine = approvalTask(board, "demo");
    db.close();
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    await waitFor(() => boards(a.msgs).length > 0);
    a.ws.send(json({ type: "task.open", taskId: t.id }));
    await waitFor(() => errors(a.msgs).length === 1);
    expect(errors(a.msgs)[0]).toContain(t.id);
    expect(a.msgs.some((m) => m.type === "task.detail")).toBe(false);
    fs.writeFileSync(path.join(projectDirs(home, "demo").sandbox, "index.html"), "<p>hi</p>");
    a.ws.send(json({ type: "task.open", taskId: mine.id }));
    await waitFor(() => a.msgs.some((m) => m.type === "task.detail"));
    const d = a.msgs.find((m) => m.type === "task.detail")!;
    if (d.type !== "task.detail") throw new Error("x");
    expect(d.task.id).toBe(mine.id);
    expect(d.task).not.toHaveProperty("nudges");
    expect(d.files.entries.map((e) => e.path)).toContain("index.html");
    expect(d.hasIndex).toBe(true);
    expect(d.previewKey).toMatch(/^[0-9a-f]{32}$/);
    expect(d.previewKey).not.toBe(s.token);
  });

  it("task.action and task.message for a task of an unwatched project return errors and change nothing", async () => {
    await makeOther();
    const { db, board } = seed();
    const t = approvalTask(board, "other");
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "task.action", taskId: t.id, action: "cancel" }));
    a.ws.send(json({ type: "task.message", taskId: t.id, text: "hi" }));
    await waitFor(() => errors(a.msgs).length === 2);
    expect(board.task(t.id)!.status).toBe("approval");
    db.close();
  });

  const pausedMsgs = (msgs: ServerMsg[]) => msgs.flatMap((m) => (m.type === "paused" ? [m.projectIds] : []));

  it("sends paused on connect", async () => {
    const s = await start();
    const a = await connect(s);
    await waitFor(() => pausedMsgs(a.msgs).length === 1);
    expect(pausedMsgs(a.msgs)[0]).toEqual([]);
    // paused comes after the first three messages
    expect(a.msgs.slice(0, 4).map((m) => m.type)).toEqual(["snapshot", "decisions", "session.list", "paused"]);
  });

  it("project.pause pauses and broadcasts to every client", async () => {
    const s = await start();
    const a = await connect(s);
    const b = await connect(s);
    await waitFor(() => pausedMsgs(a.msgs).length === 1 && pausedMsgs(b.msgs).length === 1);
    a.ws.send(json({ type: "project.pause", projectId: "demo", paused: true }));
    await waitFor(() => pausedMsgs(a.msgs).length === 2 && pausedMsgs(b.msgs).length === 2);
    expect(pausedMsgs(a.msgs)[1]).toEqual(["demo"]);
    expect(pausedMsgs(b.msgs)[1]).toEqual(["demo"]);
    b.ws.send(json({ type: "project.pause", projectId: "demo", paused: false }));
    await waitFor(() => pausedMsgs(a.msgs).length === 3 && pausedMsgs(b.msgs).length === 3);
    expect(pausedMsgs(a.msgs)[2]).toEqual([]);
  });

  it("project.pause of an unknown project replies No project <id>", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "project.pause", projectId: "nope", paused: true }));
    await waitFor(() => errors(a.msgs).length === 1);
    expect(errors(a.msgs)[0]).toBe("No project nope");
    expect(pausedMsgs(a.msgs)).toEqual([[]]);
  });

  it("city.pause true pauses every project and false resumes them", async () => {
    await makeOther();
    const s = await start();
    const a = await connect(s);
    const b = await connect(s);
    await waitFor(() => pausedMsgs(a.msgs).length === 1 && pausedMsgs(b.msgs).length === 1);
    a.ws.send(json({ type: "city.pause", paused: true }));
    await waitFor(() => pausedMsgs(b.msgs).length >= 2 && pausedMsgs(b.msgs).at(-1)!.length === 2);
    expect([...pausedMsgs(b.msgs).at(-1)!].sort()).toEqual(["demo", "other"]);
    a.ws.send(json({ type: "city.pause", paused: false }));
    await waitFor(() => pausedMsgs(a.msgs).at(-1)!.length === 0 && pausedMsgs(a.msgs).length > 2);
    await waitFor(() => pausedMsgs(b.msgs).at(-1)!.length === 0 && pausedMsgs(b.msgs).length > 2);
  });

  it("hq.do project remove while a run will not stop answers stop the runs first", async () => {
    const gate = new Blocking();
    const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: gate });
    servers.push(s);
    const b = await connect(s);
    b.ws.send(json({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    try {
      await waitFor(() => gate.calls === 1);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        b.ws.send(json({ type: "hq.do", id: "pr1", argv: ["project", "remove", "demo"] }));
        for (let i = 0; i < 120 && !b.msgs.some((m) => m.type === "hq.done" && m.id === "pr1"); i++) {
          await vi.advanceTimersByTimeAsync(100);
          await new Promise((r) => setImmediate(r));
        }
      } finally {
        vi.useRealTimers();
      }
      const done = b.msgs.find((m) => m.type === "hq.done" && m.id === "pr1");
      expect(done?.type === "hq.done" && [done.code, done.text]).toEqual([1, "stop the runs first"]);
      expect(fs.existsSync(projectDirs(home, "demo").config)).toBe(true);
    } finally {
      gate.open();
    }
  });

  it("hq.do project remove aborts a chat turn of the project and removes once the turn ends", async () => {
    const gate = new Blocking();
    const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: gate });
    servers.push(s);
    const a = await connect(s);
    try {
      a.ws.send(json({ type: "session.new", agentId: "ada", projectId: "demo" }));
      await waitFor(() => a.msgs.some((m) => m.type === "session.list" && m.sessions.length === 1));
      const list = a.msgs.filter((m) => m.type === "session.list").at(-1)!;
      const id = list.type === "session.list" ? list.sessions[0]!.id : 0;
      a.ws.send(json({ type: "session.send", sessionId: id, text: "hello" }));
      await waitFor(() => gate.calls === 1);
      a.ws.send(json({ type: "hq.do", id: "pr4", argv: ["project", "remove", "demo"] }));
      await new Promise((r) => setTimeout(r, 400));
      expect(a.msgs.some((m) => m.type === "hq.done" && m.id === "pr4")).toBe(false);
      expect(fs.existsSync(projectDirs(home, "demo").config)).toBe(true);
    } finally {
      gate.open();
    }
    await waitFor(() => a.msgs.some((m) => m.type === "hq.done" && m.id === "pr4"));
    const done = a.msgs.find((m) => m.type === "hq.done" && m.id === "pr4");
    expect(done?.type === "hq.done" && [done.code, done.text]).toEqual([0, "Removed project demo"]);
    expect(fs.existsSync(projectDirs(home, "demo").root)).toBe(false);
  });

  it("hq.do project remove deletes an idle project and broadcasts config", async () => {
    const { db, board } = seed();
    board.createGoal("demo", "a goal");
    db.close();
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "hq.do", id: "pr2", argv: ["project", "remove", "demo"] }));
    await waitFor(() => a.msgs.some((m) => m.type === "hq.done" && m.id === "pr2"));
    const done = a.msgs.find((m) => m.type === "hq.done" && m.id === "pr2");
    expect(done?.type === "hq.done" && [done.code, done.text]).toEqual([0, "Removed project demo"]);
    expect(fs.existsSync(projectDirs(home, "demo").root)).toBe(false);
    const cfg = [...a.msgs].reverse().find((m) => m.type === "hq.config");
    expect(cfg?.type === "hq.config" && cfg.config.projects.some((p) => p.id === "demo")).toBe(false);
    const db2 = openDb(home);
    expect(new BoardStore(db2).goals("demo")).toEqual([]);
    db2.close();
  });

  it("a client that connects later sees the paused projects", async () => {
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "project.pause", projectId: "demo", paused: true }));
    await waitFor(() => pausedMsgs(a.msgs).length === 2);
    const b = await connect(s);
    await waitFor(() => pausedMsgs(b.msgs).length === 1);
    expect(pausedMsgs(b.msgs)[0]).toEqual(["demo"]);
  });

  it("task.action rollback with no checkpoint replies no checkpoint yet", async () => {
    const { db, board } = seed();
    const t = approvalTask(board);
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    await waitFor(() => boards(a.msgs).length > 0);
    expect(lastBoard(a.msgs)!.tasks.find((x) => x.id === t.id)!.checkpoint).toBeNull();
    a.ws.send(json({ type: "task.action", taskId: t.id, action: "rollback" }));
    await waitFor(() => errors(a.msgs).length === 1);
    expect(errors(a.msgs)[0]).toBe("no checkpoint yet");
    expect(board.task(t.id)!.status).toBe("approval");
    db.close();
  });

  it("review.answer for a task in the decisions list works without watching its project", async () => {
    await makeOther();
    const { db, board } = seed();
    const t = approvalTask(board, "other");
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "review.answer", taskId: t.id, option: "reject" }));
    await waitFor(() => results(a.msgs).length === 1);
    expect(results(a.msgs)[0]).toMatchObject({ taskId: t.id, ok: true });
    db.close();
  });

  it("review.answer merge with uncommitted changes in the project root returns ok false and the task stays in approval", async () => {
    await linkRepo();
    const { db, board } = seed();
    const t = approvalTask(board);
    git("branch", t.branch!);
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted");
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "review.answer", taskId: t.id, option: "merge" }));
    await waitFor(() => results(a.msgs).length === 1);
    expect(results(a.msgs)[0]).toMatchObject({ taskId: t.id, ok: false });
    expect(results(a.msgs)[0]!.error).toContain("uncommitted");
    expect(board.task(t.id)!.status).toBe("approval");
    db.close();
  });

  it("review.answer merge merges a clean branch, and the task is done", async () => {
    await linkRepo();
    const { db, board } = seed();
    const t = approvalTask(board);
    git("switch", "-q", "-c", t.branch!);
    fs.writeFileSync(path.join(repo, "b.txt"), "two\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");
    git("switch", "-q", "main");
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "review.answer", taskId: t.id, option: "merge" }));
    await waitFor(() => results(a.msgs).length === 1);
    expect(results(a.msgs)[0]).toEqual({ type: "review.result", taskId: t.id, ok: true });
    expect(board.task(t.id)!.status).toBe("done");
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(true);
    db.close();
  });

  it("diff.request returns the files of the task branch", async () => {
    await linkRepo();
    const { db, board } = seed();
    const t = approvalTask(board);
    git("switch", "-q", "-c", t.branch!);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");
    git("switch", "-q", "main");
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "diff.request", taskId: t.id }));
    await waitFor(() => a.msgs.some((m) => m.type === "diff"));
    const d = a.msgs.find((m) => m.type === "diff")!;
    if (d.type !== "diff") throw new Error("x");
    expect(d.taskId).toBe(t.id);
    expect(d.files).toHaveLength(1);
    expect(d.files[0]).toMatchObject({ path: "a.txt", status: "modified", additions: 1, deletions: 0 });
    db.close();
  });

  /** A goal whose plan waits for the player. */
  const planGoal = (board: BoardStore, project = "demo") => {
    const g = board.createGoal(project, "make pong");
    board.proposePlan(g.id, "boss", "Steps: make pong.");
    return g;
  };
  const planResults = (msgs: ServerMsg[]) => msgs.flatMap((m) => (m.type === "plan.result" ? [m] : []));

  it("the decisions message lists the plan", async () => {
    const { db, board } = seed();
    const g = planGoal(board);
    db.close();
    const s = await start();
    const a = await connect(s);
    await waitFor(() => a.msgs.some((m) => m.type === "decisions"));
    const d = a.msgs.filter((m) => m.type === "decisions").at(-1)!;
    if (d.type !== "decisions") throw new Error("x");
    expect(d.list.map((x) => x.id)).toEqual([`p:${g.id}`]);
    expect(d.list[0]).toMatchObject({ kind: "plan", goalId: g.id, projectId: "demo", agentId: "boss", text: "Steps: make pong." });
  });

  it("plan.answer approve moves the goal on and replies ok", async () => {
    const { db, board } = seed();
    const g = planGoal(board);
    db.close();
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "plan.answer", goalId: g.id, option: "approve" }));
    await waitFor(() => planResults(a.msgs).length === 1);
    expect(planResults(a.msgs)[0]).toEqual({ type: "plan.result", goalId: g.id, ok: true });
    const chk = seed();
    expect(chk.board.goal(g.id)!.planState).toBe("approved");
    chk.db.close();
  });

  it("plan.answer for a waiting plan of an unwatched project replies ok", async () => {
    await makeOther();
    const { db, board } = seed();
    const g = planGoal(board, "other");
    db.close();
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "plan.answer", goalId: g.id, option: "approve" }));
    await waitFor(() => planResults(a.msgs).length === 1);
    expect(planResults(a.msgs)[0]).toEqual({ type: "plan.result", goalId: g.id, ok: true });
  });

  it("plan.answer for a goal of an unwatched project with no waiting plan replies ok false", async () => {
    await makeOther();
    const { db, board } = seed();
    const g = board.createGoal("other", "make pong");
    db.close();
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "plan.answer", goalId: g.id, option: "approve" }));
    await waitFor(() => planResults(a.msgs).length === 1);
    expect(planResults(a.msgs)[0]).toEqual({ type: "plan.result", goalId: g.id, ok: false, error: `${g.id} is not a goal of a project you watch` });
    const chk = seed();
    expect(chk.board.goal(g.id)!.planState).toBe("none");
    chk.db.close();
  });

  it("connect gets the decisions list with the waiting approval task as m:<id>", async () => {
    const { db, board } = seed();
    const t = approvalTask(board);
    db.close();
    const s = await start();
    const a = await connect(s);
    await waitFor(() => a.msgs.some((m) => m.type === "decisions"));
    const d = a.msgs.filter((m) => m.type === "decisions").at(-1)!;
    if (d.type !== "decisions") throw new Error("x");
    expect(d.list.map((x) => x.id)).toEqual([`m:${t.id}`]);
    expect(d.list[0]).toMatchObject({ kind: "merge", taskId: t.id, projectId: "demo" });
    expect(a.msgs.findIndex((m) => m.type === "decisions")).toBe(a.msgs.findIndex((m) => m.type === "snapshot") + 1);
  });

  it("a task entering approval sends a new decisions list", async () => {
    const s = await start();
    const a = await connect(s);
    await waitFor(() => a.msgs.some((m) => m.type === "decisions"));
    const { db, board } = seed();
    const t = approvalTask(board);
    db.close();
    await waitFor(() => a.msgs.filter((m) => m.type === "decisions").length === 2);
    const d = a.msgs.filter((m) => m.type === "decisions").at(-1)!;
    if (d.type !== "decisions") throw new Error("x");
    expect(d.list.map((x) => x.id)).toEqual([`m:${t.id}`]);
  });

  it("a blocked task of a planning goal reaches the Inbox", async () => {
    const { db, board } = seed();
    const g = board.createGoal("demo", "make the menu");
    const t = board.createTask({ goalId: g.id, title: "work", description: "d", assignee: "ada", createdBy: "ada" });
    board.setStatus(t.id, "blocked", { force: true });
    board.update(t.id, { blockedReason: "merge conflict" });
    db.close();
    const s = await start();
    const a = await connect(s);
    await waitFor(() => a.msgs.some((m) => m.type === "decisions"));
    const d = a.msgs.filter((m) => m.type === "decisions").at(-1)!;
    if (d.type !== "decisions") throw new Error("x");
    expect(d.list.map((x) => x.id)).toEqual([`b:${t.id}`]);
  });

  it("sends no second decisions message when nothing changed", async () => {
    const { db, board } = seed();
    approvalTask(board);
    db.close();
    const s = await start();
    const a = await connect(s);
    await waitFor(() => a.msgs.some((m) => m.type === "decisions"));
    await new Promise((r) => setTimeout(r, 3 * 50 + 100));
    expect(a.msgs.filter((m) => m.type === "decisions")).toHaveLength(1);
  });

  it("file.request returns one file of the task folder and refuses a protected one", async () => {
    await linkRepo();
    const { db, board } = seed();
    const t = approvalTask(board);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello file\n");
    fs.writeFileSync(path.join(repo, ".env"), "KEY=1\n");
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "file.request", taskId: t.id, path: "a.txt" }));
    a.ws.send(json({ type: "file.request", taskId: t.id, path: ".env" }));
    await waitFor(() => a.msgs.filter((m) => m.type === "file").length === 2);
    const files = a.msgs.filter((m) => m.type === "file");
    const ok = files.find((m) => m.type === "file" && m.path === "a.txt");
    const refused = files.find((m) => m.type === "file" && m.path === ".env");
    if (ok?.type !== "file" || refused?.type !== "file") throw new Error("x");
    expect(ok).toMatchObject({ taskId: t.id, path: "a.txt", text: "hello file\n", binary: false });
    expect(refused.error).toBe("protected path");
    expect(refused.text).toBeUndefined();
    db.close();
  });

  it("task.open pushes new log rows of the open task as task.log", async () => {
    const { db, board } = seed();
    const t = approvalTask(board);
    board.addRun(t.id, "run-x", "work");
    const log = new ActionLog(db, []);
    log.append({ projectId: "demo", agentId: "ada", runId: "run-x", type: "run.started", payload: { goal: "do it" } });
    const s = await start();
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "task.open", taskId: t.id }));
    await waitFor(() => a.msgs.some((m) => m.type === "task.detail"));
    const d = a.msgs.find((m) => m.type === "task.detail")!;
    expect(d.type === "task.detail" && d.log.map((r) => r.text)).toEqual(["started: do it"]);
    log.append({ projectId: "demo", agentId: "ada", runId: "run-x", type: "tool.requested", payload: { call: { name: "write_file", args: { path: "a.txt" } } } });
    await waitFor(() => a.msgs.some((m) => m.type === "task.log"));
    const l = a.msgs.find((m) => m.type === "task.log")!;
    expect(l.type === "task.log" && [l.taskId, l.rows.map((r) => r.text)]).toEqual([t.id, ["write_file a.txt"]]);
    db.close();
  });

  it("a chat message to an agent with a running job goes to the scheduler and the chat says so", async () => {
    const i = io();
    expect(await runCli(["agent", "create", "boss", "--name", "Boss", "--role", "boss", "--model", "lmstudio/test", "--persona", "You are Boss."], { home, io: i })).toBe(0);
    expect(await runCli(["grant", "demo", "boss"], { home, io: i })).toBe(0);
    const gate = new Blocking();
    // The player approved the plan already, so the scheduler goes straight to the boss's team task.
    const seeded = seed();
    const goal = seeded.board.createGoal("demo", "make pong");
    seeded.board.proposePlan(goal.id, "boss", "Steps: make pong.");
    seeded.board.setPlanState(goal.id, "approved");
    seeded.db.close();
    const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: gate });
    servers.push(s);
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    // No manager: the boss owns team task t1 and splits it in a job that waits for the model.
    await waitFor(() => gate.calls === 1, 8000);
    a.ws.send(json({ type: "session.new", agentId: "boss", projectId: "demo" }));
    await waitFor(() => a.msgs.some((m) => m.type === "session.list" && m.sessions.some((x) => x.agentId === "boss")));
    const list = a.msgs.filter((m) => m.type === "session.list").at(-1)!;
    const id = list.type === "session.list" ? list.sessions.find((x) => x.agentId === "boss")!.id : 0;
    a.ws.send(json({ type: "session.send", sessionId: id, text: "use blue" }));
    await waitFor(() => a.msgs.some((m) => m.type === "session.msg" && m.message.kind === "system" && m.message.text === "sent to Boss on t1"));
    const user = a.msgs.find((m) => m.type === "session.msg" && m.message.kind === "user");
    expect(user?.type === "session.msg" && [user.message.text, user.message.status]).toEqual(["use blue", "done"]);
    // no chat turn started: the only model call is the split job's
    expect(gate.calls).toBe(1);
    gate.open();
  }, 20_000);

  it("a boss chat can post a goal with create_goal, and the board shows it", async () => {
    const i = io();
    expect(await runCli(["agent", "create", "boss", "--name", "Boss", "--role", "boss", "--model", "lmstudio/test", "--persona", "You are Boss."], { home, io: i })).toBe(0);
    expect(await runCli(["grant", "demo", "boss"], { home, io: i })).toBe(0);
    const provider = new FakeProvider([call("c1", "create_goal", { project: "demo", text: "build a clock" }), say("posted g1"), say("ok"), say("ok")]);
    // After the goal, the scheduler plans it. Its model calls get a quiet answer.
    const s = await startCityServer({ home, port: 0, staticDir, pollMs: 50, providerOverride: provider });
    servers.push(s);
    const a = await connect(s);
    a.ws.send(json({ type: "board.watch", projectId: "demo" }));
    a.ws.send(json({ type: "session.new", agentId: "boss" }));
    await waitFor(() => a.msgs.some((m) => m.type === "session.list" && m.sessions.length === 1));
    const list = a.msgs.filter((m) => m.type === "session.list").at(-1)!;
    const id = list.type === "session.list" ? list.sessions[0]!.id : 0;
    a.ws.send(json({ type: "session.send", sessionId: id, text: "start a clock" }));
    await waitFor(() => lastBoard(a.msgs)?.goals.some((g) => g.text === "build a clock") === true, 8000);
    expect(provider.requests[0]!.tools.map((t) => t.name).sort()).toEqual(["create_goal", "remember"]);
  });
});

describe("city preview", () => {
  const getH = (s: CityServer, p: string, host = `127.0.0.1:${s.port}`) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: s.port, path: p, headers: { host } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on("error", reject);
    });

  /** Opens task t1 of demo and returns the preview key the server gave. */
  const setup = async (worktree?: string) => {
    const db = openDb(home);
    const board = new BoardStore(db);
    const g = board.createGoal("demo", "site");
    const team = board.createTask({ goalId: g.id, title: "team", description: "d", assignee: "ada", createdBy: "ada" });
    const t = board.createTask({ goalId: g.id, parentId: team.id, title: "page", description: "d", assignee: "ada", createdBy: "ada" });
    if (worktree) board.update(t.id, { worktree });
    db.close();
    const s = await start();
    const a = await connect(s);
    a.ws.send(JSON.stringify({ type: "board.watch", projectId: "demo" }));
    a.ws.send(JSON.stringify({ type: "task.open", taskId: t.id }));
    await waitFor(() => a.msgs.some((m) => m.type === "task.detail"));
    const d = a.msgs.find((m) => m.type === "task.detail")!;
    return { s, key: d.type === "task.detail" ? d.previewKey : "", taskId: t.id };
  };

  it("serves index.html of the project root with the CSP and nosniff", async () => {
    const root = projectDirs(home, "demo").sandbox;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), "<html>site</html>");
    fs.writeFileSync(path.join(root, "app.js"), "1");
    fs.writeFileSync(path.join(root, ".env"), "KEY=1");
    const { s, key, taskId } = await setup();
    const r = await getH(s, `/p/${key}/${taskId}/`);
    expect(r.status).toBe(200);
    expect(r.body).toBe("<html>site</html>");
    expect(r.headers["content-security-policy"]).toBe("default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'; sandbox allow-scripts");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-type"]).toContain("text/html");
    expect((await getH(s, `/p/${key}/${taskId}/app.js`)).headers["content-type"]).toContain("text/javascript");
    expect((await getH(s, `/p/${key}/${taskId}/index.html?x=1`)).status).toBe(200);
  });

  it("serves the task worktree while it exists", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ac-city-wt-"));
    try {
      fs.writeFileSync(path.join(wt, "index.html"), "<html>worktree</html>");
      const { s, key, taskId } = await setup(wt);
      expect((await getH(s, `/p/${key}/${taskId}/`)).body).toBe("<html>worktree</html>");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it("falls back to the project root when the worktree is gone", async () => {
    const root = projectDirs(home, "demo").sandbox;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), "<html>root</html>");
    const { s, key, taskId } = await setup(path.join(os.tmpdir(), "ac-no-such-worktree"));
    expect((await getH(s, `/p/${key}/${taskId}/`)).body).toBe("<html>root</html>");
  });

  it("answers 404 for a wrong key, traversal, a protected file, an unknown task and another Host", async () => {
    const root = projectDirs(home, "demo").sandbox;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), "<html>site</html>");
    fs.writeFileSync(path.join(root, ".env"), "KEY=1");
    const { s, key, taskId } = await setup();
    const wrong = "0".repeat(32);
    for (const p of [
      `/p/${wrong}/${taskId}/`,
      `/p/${key}/${taskId}/%2e%2e/project.json`,
      `/p/${key}/${taskId}/..%5Cproject.json`,
      `/p/${key}/${taskId}/%2e%2e%5C%2e%2e%5Cagentcity.db`,
      `/p/${key}/${taskId}/.env`,
      `/p/${key}/${taskId}/missing.html`,
      `/p/${key}/t999/`,
      `/p/${key}/nope/`,
      `/p/${key}/`,
      `/p/${key}`,
      `/p/${s.token}/${taskId}/`,
    ]) expect((await getH(s, p)).status, p).toBe(404);
    expect((await getH(s, `/p/${key}/${taskId}/`, `localhost:${s.port}`)).status).toBe(404);
    expect((await getH(s, `/p/${key}/${taskId}/`)).status).toBe(200);
  });
});

describe("restart and the agentcity link", () => {
  /** Runs `argv` until it prints the city address; returns the address and the interrupt. */
  const serve = async (argv: string[], provider = new FakeProvider([])) => {
    const i = io();
    let handler: (() => void | Promise<void>) | undefined;
    const done = runCli(argv, {
      home, io: i, staticDir, providerOverride: provider,
      registerInterrupt: (h) => { handler = h; return () => undefined; }, exit: () => undefined,
    });
    await waitFor(() => handler !== undefined);
    const url = new URL(text(i.output).trim());
    return { port: Number(url.port), token: url.searchParams.get("t")!, stop: async () => { await handler!(); await done; } };
  };
  const dial = async (port: number, token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`, { origin: `http://127.0.0.1:${port}` });
    sockets.push(ws);
    const msgs: ServerMsg[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as ServerMsg));
    await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
    return { ws, msgs };
  };

  it("a restarted city keeps its token, agents and session threads", async () => {
    const first = await serve(["city", "--no-open", "--port", "0"], new FakeProvider([say("menu built")]));
    const a = await dial(first.port, first.token);
    a.ws.send(JSON.stringify({ type: "session.send", projectId: "demo", agentId: "ada", text: "build the menu" }));
    await waitFor(() => a.msgs.some((m) => m.type === "session.msg" && m.message.kind === "agent"));
    a.ws.close();
    await first.stop();

    const second = await serve(["link", "open", "agentcity://start", "--home", home, "--port", "0"]);
    expect(second.token).toBe(first.token);
    const b = await dial(second.port, first.token);
    await waitFor(() => b.msgs.some((m) => m.type === "session.list" && m.sessions.some((s) => s.agentId === "ada" && s.last === "Ada: menu built")));
    await waitFor(() => b.msgs.some((m) => m.type === "snapshot" && m.state.agents.some((x) => x.id === "ada")));
    await second.stop();
  });

  it("link open refuses other links and does nothing when the city already answers", async () => {
    const i = io();
    expect(await runCli(["link", "open", "agentcity://start?home=C:/x"], { home, io: i, staticDir })).toBe(1);
    expect(text(i.error)).toContain("Not an Agent City link");
    const s = await start();
    const j = io();
    expect(await runCli(["link", "open", "agentcity://start", "--port", String(s.port)], { home, io: j, staticDir })).toBe(0);
    expect(text(j.output)).toContain(`The city already runs on port ${s.port}.`);
  });

  it("link install, status and remove go through reg for this user, on Windows only", async () => {
    const keys = new Map<string, string>();
    const reg = (args: string[]) => {
      const [verb, key] = args;
      if (verb === "add") keys.set(`${key}|${args.includes("/ve") ? "" : args[args.indexOf("/v") + 1]}`, args[args.indexOf("/d") + 1]!);
      if (verb === "delete") keys.clear();
      if (verb === "query") {
        const v = keys.get(`${key}|`);
        return v === undefined ? { code: 1, out: "ERROR" } : { code: 0, out: `    (Default)    REG_SZ    ${v}\r\n` };
      }
      return { code: 0, out: "" };
    };
    const d = (i: ReturnType<typeof io>) => ({ home, io: i, staticDir, reg, platform: "win32" as const });
    const i = io();
    expect(await runCli(["link", "status"], d(i))).toBe(1);
    expect(text(i.error)).toContain("not installed");
    const j = io();
    expect(await runCli(["link", "install", "--port", "4400"], d(j))).toBe(0);
    expect(text(j.output)).toContain(`it starts the city on ${home}, port 4400`);
    const command = keys.get("HKCU\\Software\\Classes\\agentcity\\shell\\open\\command|")!;
    expect(command).toBe(`"${process.execPath}" "${path.resolve("packages/cli/src/main.js")}" link open --home "${home}" --port 4400 "%1"`);
    const k = io();
    // main.js exists only after a build; status names whatever is missing.
    await runCli(["link", "status"], d(k));
    expect(text(k.output)).toContain("runs: ");
    expect(await runCli(["link", "remove"], d(io()))).toBe(0);
    expect(keys.size).toBe(0);
    const m = io();
    expect(await runCli(["link", "install"], { ...d(m), platform: "linux" })).toBe(1);
    expect(text(m.error)).toContain("Windows only");
  });
});

describe("city command", () => {
  it("prints port in use and exits 1", async () => {
    const s = await start();
    const i = io();
    // Another home, so the busy port is the only reason to refuse.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ac-city-other-"));
    expect(await runCli(["city", "--no-open", "--port", String(s.port)], { home: other, io: i, staticDir })).toBe(1);
    expect(text(i.error)).toContain(`port ${s.port} in use, try --port`);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("prints the build message when the client is missing", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ac-empty-"));
    const i = io();
    expect(await runCli(["city", "--no-open"], { home, io: i, staticDir: empty })).toBe(1);
    expect(text(i.error)).toContain("client not built, run npm run build");
  });

  it("interrupt denies waiting approvals, aborts the run and exits 130", async () => {
    const i = io();
    let handler: (() => void | Promise<void>) | undefined;
    const codes: number[] = [];
    const cmd = runCli(["city", "--no-open", "--port", "0"], {
      home, io: i, staticDir, providerOverride: new FakeProvider([send("1"), say("done")]),
      registerInterrupt: (h) => { handler = h; return () => undefined; },
      exit: (c) => void codes.push(c),
    });
    await waitFor(() => handler !== undefined);
    const url = text(i.output).trim();
    const port = Number(new URL(url).port);
    const token = new URL(url).searchParams.get("t")!;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`, { origin: `http://127.0.0.1:${port}` });
    sockets.push(ws);
    const msgs: ServerMsg[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as ServerMsg));
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "run", projectId: "demo", agentId: "ada", goal: "go" }));
    await waitFor(() => msgs.some((m) => m.type === "patch" && (m.approvals?.length ?? 0) > 0), 5000);
    await handler!();
    expect(codes).toEqual([130]);
    await cmd;
    expect(outbox()).toBe(0);
    const db = openDb(home);
    const reasons = new ActionLog(db, []).list("demo").filter((a) => a.type === "run.stopped");
    db.close();
    expect(reasons.length).toBe(1);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});
