import { ServerMsgSchema, type CityState, type ClientMsg, type DecisionView, type ServerMsg } from "@agentcity/world/shared";

/** Snapshot replaces the state. Patch merges agents and plots by id and replaces approvals and runs. Other messages keep it. */
export function applyServerMsg(state: CityState | null, m: ServerMsg): CityState | null {
  if (m.type === "snapshot") return m.state;
  if (m.type !== "patch" || !state) return state;
  return {
    agents: m.agents ? mergeById(state.agents, m.agents) : state.agents,
    plots: m.plots ? mergeById(state.plots, m.plots) : state.plots,
    approvals: m.approvals ?? state.approvals,
    runs: m.runs ?? state.runs,
  };
}

function mergeById<T extends { id: string }>(list: T[], changed: T[]): T[] {
  const byId = new Map(changed.map((c) => [c.id, c]));
  const out = list.map((x) => byId.get(x.id) ?? x);
  for (const c of changed) if (!list.some((x) => x.id === c.id)) out.push(c);
  return out;
}

/** The part of WebSocket that CityClient uses. */
export interface SocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export const RECONNECT_MS = 2000;

/** Websocket to the city server. Reconnects every 2000 ms after a close. Sends while offline are dropped. */
export class CityClient {
  online = false;
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly onMsg: (m: ServerMsg) => void,
    private readonly makeSocket: (url: string) => SocketLike = (u) => new WebSocket(u) as unknown as SocketLike,
    private readonly onStatus: (online: boolean) => void = () => undefined,
  ) {
    this.connect();
  }

  send(m: ClientMsg): void {
    if (this.online && this.socket) this.socket.send(JSON.stringify(m));
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }

  private connect(): void {
    const s = this.makeSocket(this.url);
    this.socket = s;
    s.onopen = () => this.setOnline(true);
    s.onmessage = (e) => {
      let json: unknown;
      try { json = JSON.parse(String(e.data)); } catch { return; }
      const r = ServerMsgSchema.safeParse(json);
      if (r.success) this.onMsg(r.data);
    };
    s.onclose = () => {
      this.setOnline(false);
      if (this.socket !== s) return;
      this.socket = null;
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  private setOnline(v: boolean): void {
    if (this.online === v) return;
    this.online = v;
    this.onStatus(v);
  }
}

/** Websocket URL for the page, from its `t` query param or the token the city server put in the page. null without one (offline demo). */
export function socketUrl(loc: { protocol: string; host: string; search: string }, pageToken: string | null = null): string | null {
  const t = new URLSearchParams(loc.search).get("t") ?? pageToken;
  if (!t) return null;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/ws?t=${encodeURIComponent(t)}`;
}

/** Shared city state for the scenes: the last applied state plus listeners. */
export class CityModel {
  state: CityState | null = null;
  /** The decisions that wait on the player, oldest first. */
  decisions: DecisionView[] = [];
  /** Agents with failing CI. */
  failing: string[] = [];
  online = false;
  private listeners = new Set<(s: CityState, prev: CityState | null) => void>();
  private msgListeners = new Set<(m: ServerMsg) => void>();
  private statusListeners = new Set<(online: boolean) => void>();

  apply(m: ServerMsg): void {
    for (const l of this.msgListeners) l(m);
    if (m.type === "decisions") {
      // Decisions live outside CityState, so subscribers get the unchanged state. Nothing is called before a snapshot.
      this.decisions = m.list;
      this.failing = m.failing;
      if (this.state) for (const l of this.listeners) l(this.state, this.state);
      return;
    }
    const prev = this.state;
    const next = applyServerMsg(prev, m);
    if (!next || next === prev) return;
    this.state = next;
    for (const l of this.listeners) l(next, prev);
  }

  subscribe(fn: (s: CityState, prev: CityState | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Every server message, including term.out, term.done and error, which do not change the state. */
  onMessage(fn: (m: ServerMsg) => void): () => void {
    this.msgListeners.add(fn);
    return () => this.msgListeners.delete(fn);
  }

  setOnline(v: boolean): void {
    if (this.online === v) return;
    this.online = v;
    for (const l of this.statusListeners) l(v);
  }

  onStatus(fn: (online: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
}
