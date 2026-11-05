import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentView, CityState, DecisionView, ServerMsg } from "@agentcity/world/shared";
import { CityClient, CityModel, applyServerMsg, type SocketLike } from "../src/net.js";

const agent = (id: string, activity: AgentView["activity"] = "idle"): AgentView => ({
  id, name: id, role: "worker", building: "software", activity, buildingId: "software",
});

describe("applyServerMsg", () => {
  const state: CityState = { agents: [agent("a"), agent("b")], plots: [{ id: "plot-1" }], approvals: [], runs: [] };
  it("replaces state on snapshot", () => {
    expect(applyServerMsg(null, { type: "snapshot", state })).toEqual(state);
  });
  it("merges a patch by id and keeps the rest", () => {
    const next = applyServerMsg(state, {
      type: "patch", agents: [agent("b", "writing")], plots: [{ id: "plot-1", kind: "library" }],
    })!;
    expect(next.agents).toEqual([agent("a"), agent("b", "writing")]);
    expect(next.plots).toEqual([{ id: "plot-1", kind: "library" }]);
    expect(state.agents[1]!.activity).toBe("idle");
  });
  it("adds a new agent from a patch and replaces approvals", () => {
    const ap = { id: 1, projectId: "p", agentId: "a", tool: "build", argsPreview: "", tier: 2, estimatedUsd: 0, local: true };
    const next = applyServerMsg(state, { type: "patch", agents: [agent("c")], approvals: [ap] })!;
    expect(next.agents.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(next.approvals).toEqual([ap]);
  });
  it("ignores a patch before any snapshot, and terminal messages", () => {
    expect(applyServerMsg(null, { type: "patch", agents: [agent("a")] })).toBeNull();
    expect(applyServerMsg(state, { type: "term.out", text: "x" })).toBe(state);
  });
});

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(s: string): void { this.sent.push(s); }
  close(): void { this.onclose?.(); }
}

describe("CityClient", () => {
  beforeEach(() => { vi.useFakeTimers(); FakeSocket.all = []; });
  afterEach(() => { vi.useRealTimers(); });

  it("sets online on open, delivers valid messages and drops invalid ones", () => {
    const got: ServerMsg[] = [];
    const c = new CityClient("ws://x/ws?t=1", (m) => got.push(m), (u) => new FakeSocket(u));
    expect(c.online).toBe(false);
    const s = FakeSocket.all[0]!;
    s.onopen!();
    expect(c.online).toBe(true);
    s.onmessage!({ data: JSON.stringify({ type: "term.done", code: 0 }) });
    s.onmessage!({ data: "{bad" });
    s.onmessage!({ data: JSON.stringify({ type: "nope" }) });
    expect(got).toEqual([{ type: "term.done", code: 0 }]);
    c.close();
  });

  it("drops sends while offline and reconnects 2000 ms after close", () => {
    const c = new CityClient("ws://x/ws?t=1", () => undefined, (u) => new FakeSocket(u));
    const s1 = FakeSocket.all[0]!;
    c.send({ type: "term.in", line: "agent list" });
    expect(s1.sent).toEqual([]);
    s1.onopen!();
    c.send({ type: "term.in", line: "agent list" });
    expect(s1.sent).toHaveLength(1);
    s1.onclose!();
    expect(c.online).toBe(false);
    c.send({ type: "term.in", line: "x" });
    expect(s1.sent).toHaveLength(1);
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.onopen!();
    expect(c.online).toBe(true);
    c.close();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all).toHaveLength(2);
  });
});

describe("CityModel decisions", () => {
  const decision: DecisionView = {
    id: "d1", kind: "approval", projectId: "p", agentId: "a", title: "Approve build", text: "npm run build", since: "2026-11-03T09:00:00Z",
  };
  const state: CityState = { agents: [agent("a")], plots: [], approvals: [], runs: [] };

  it("starts with no decisions and no failing agents", () => {
    const m = new CityModel();
    expect(m.decisions).toEqual([]);
    expect(m.failing).toEqual([]);
  });

  it("applies a decisions message, sets both lists and notifies subscribers", () => {
    const m = new CityModel();
    m.apply({ type: "snapshot", state });
    const seen: number[] = [];
    m.subscribe(() => seen.push(m.decisions.length));
    m.apply({ type: "decisions", list: [decision], failing: ["a"] });
    expect(m.decisions).toEqual([decision]);
    expect(m.failing).toEqual(["a"]);
    expect(seen).toEqual([1]);
    expect(m.state).toEqual(state);
  });
});
