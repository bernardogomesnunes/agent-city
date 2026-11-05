import { describe, expect, it } from "vitest";
import { BUILDINGS, type AgentView, type DecisionView } from "@agentcity/world/shared";
import { StepMover, advanceAlongPath, assignSlots, buildingAt, dirOf, hqDeskEvent, lampOf, podiumSpots, type Dir, type PathWalker } from "../src/actors.js";

const open = () => true;

describe("StepMover", () => {
  it("turns in place on a tap under 100 ms in a new direction", () => {
    const m = new StepMover(open, 5, 5, "down");
    expect(m.press("left", 40, false)).toEqual({ kind: "turn", dir: "left" });
    expect([m.x, m.y, m.facing]).toEqual([5, 5, "left"]);
    // Still a tap on the next frame: no step yet.
    expect(m.press("left", 80, false).kind).toBe("turn");
    expect([m.x, m.y]).toEqual([5, 5]);
  });
  it("steps one tile when the key is held past 100 ms", () => {
    const m = new StepMover(open, 5, 5, "down");
    m.press("right", 10, false);
    expect(m.press("right", 120, false)).toEqual({ kind: "step", dir: "right", x: 6, y: 5, ms: 125 });
    expect([m.x, m.y, m.facing]).toEqual([6, 5, "right"]);
  });
  it("steps at once in the facing direction", () => {
    const m = new StepMover(open, 5, 5, "up");
    expect(m.press("up", 0, false)).toEqual({ kind: "step", dir: "up", x: 5, y: 4, ms: 125 });
  });
  it("steps on a fresh tap after a turn was released", () => {
    const m = new StepMover(open, 5, 5, "down");
    m.press("left", 30, false);
    m.release();
    expect(m.press("left", 0, false).kind).toBe("step");
  });
  it("bumps without moving when the target is blocked", () => {
    const m = new StepMover((x) => x < 6, 5, 5, "right");
    expect(m.press("right", 200, false)).toEqual({ kind: "bump", dir: "right", ms: 125 });
    expect([m.x, m.y]).toEqual([5, 5]);
  });
  it("halves the step duration with Shift", () => {
    const m = new StepMover(open, 5, 5, "down");
    expect(m.press("down", 200, true)).toEqual({ kind: "step", dir: "down", x: 5, y: 6, ms: 62 });
  });
});

describe("buildingAt", () => {
  const hq = BUILDINGS.find((b) => b.id === "hq")!;
  it("finds the building on its door and its wall", () => {
    expect(buildingAt(hq.door.x, hq.door.y)).toBe("hq");
    expect(buildingAt(hq.x, hq.y)).toBe("hq");
  });
  it("is null on grass", () => {
    expect(buildingAt(1, 28)).toBeNull();
  });
});

const agent = (id: string, buildingId: AgentView["buildingId"]): AgentView => ({
  id, name: id, role: "worker", building: "software", activity: "idle", buildingId,
});

describe("assignSlots", () => {
  it("fills software's 4 slots in id order and puts 3 more outside the door", () => {
    const sw = BUILDINGS.find((b) => b.id === "software")!;
    const ids = ["g", "a", "f", "b", "e", "c", "d"];
    const out = assignSlots(ids.map((id) => agent(id, "software")));
    expect(out.size).toBe(7);
    ["a", "b", "c", "d"].forEach((id, i) => expect(out.get(id)).toEqual({ buildingId: "software", ...sw.slots[i]! }));
    const below = sw.door.y + 1;
    expect(out.get("e")).toEqual({ buildingId: "software", x: sw.door.x - 1, y: below });
    expect(out.get("f")).toEqual({ buildingId: "software", x: sw.door.x + 1, y: below });
    expect(out.get("g")).toEqual({ buildingId: "software", x: sw.door.x - 2, y: below });
  });
  it("keeps buildings apart", () => {
    const out = assignSlots([agent("a", "hq"), agent("b", "director")]);
    expect(out.get("a")!.buildingId).toBe("hq");
    expect(out.get("b")).toEqual({ buildingId: "director", ...BUILDINGS[0]!.slots[0]! });
  });
});

describe("dirOf", () => {
  it("names each of the 4 grid steps", () => {
    const o = { x: 5, y: 5 };
    expect([dirOf(o, { x: 6, y: 5 }), dirOf(o, { x: 4, y: 5 }), dirOf(o, { x: 5, y: 6 }), dirOf(o, { x: 5, y: 4 })])
      .toEqual(["right", "left", "down", "up"]);
  });
});

describe("advanceAlongPath", () => {
  function fakeWalker(x: number, y: number) {
    const log: string[] = [];
    let done: (() => void) | undefined;
    const w: PathWalker = {
      tx: x, ty: y, moving: false,
      step(tx, ty, dir, ms, cb) { log.push(`step ${tx},${ty} ${dir} ${ms}`); w.tx = tx; w.ty = ty; w.moving = true; done = cb; },
      face(dir: Dir) { log.push(`face ${dir}`); },
    };
    const finish = () => { w.moving = false; done?.(); };
    return { w, log, finish };
  }

  it("steps one tile per call at 250 ms, waits while moving, faces rest after the last tile", () => {
    const { w, log, finish } = fakeWalker(1, 1);
    const path = [{ x: 2, y: 1 }, { x: 2, y: 2 }];
    expect(advanceAlongPath(w, path, "up")).toBe(true);
    expect(advanceAlongPath(w, path, "up")).toBe(false);
    finish();
    expect(advanceAlongPath(w, path, "up")).toBe(true);
    finish();
    expect(advanceAlongPath(w, path, "up")).toBe(false);
    expect(path).toEqual([]);
    expect(log).toEqual(["step 2,1 right 250", "step 2,2 down 250", "face up"]);
  });

  it("does nothing on an empty path", () => {
    const { w, log } = fakeWalker(1, 1);
    expect(advanceAlongPath(w, [], "down")).toBe(false);
    expect(log).toEqual([]);
  });
});

describe("hqDeskEvent", () => {
  const desk = { x: 3, y: 8 };
  it("arriving on the desk gives hq-front-desk", () => {
    expect(hqDeskEvent({ x: 3, y: 9 }, desk, desk)).toBe("hq-front-desk");
  });
  it("leaving the desk gives hq-away", () => {
    expect(hqDeskEvent(desk, { x: 3, y: 9 }, desk)).toBe("hq-away");
  });
  it("a step between two other tiles gives null", () => {
    expect(hqDeskEvent({ x: 3, y: 10 }, { x: 3, y: 9 }, desk)).toBeNull();
  });
});

const dec = (id: string, agentId: string): DecisionView => ({
  id, kind: "blocked", projectId: "p", agentId, title: "t", text: "x", since: "2026-11-03T10:00:00Z",
});

describe("podiumSpots", () => {
  it("spots follow decision order", () => {
    const m = podiumSpots([dec("1", "b"), dec("2", "a"), dec("3", "c")], ["a", "b", "c"]);
    expect(m.get("b")).toEqual({ x: 22, y: 11 });
    expect(m.get("a")).toEqual({ x: 23, y: 11 });
    expect(m.get("c")).toEqual({ x: 24, y: 11 });
  });
  it("one spot per agent", () => {
    const m = podiumSpots([dec("1", "a"), dec("2", "a"), dec("3", "b")], ["a", "b"]);
    expect(m.size).toBe(2);
    expect(m.get("b")).toEqual({ x: 23, y: 11 });
  });
  it("a ninth agent gets no spot", () => {
    const ids = "abcdefghi".split("");
    const m = podiumSpots(ids.map((id, i) => dec(String(i), id)), ids);
    expect(m.size).toBe(8);
    expect(m.has("i")).toBe(false);
    expect(m.get("h")).toEqual({ x: 25, y: 12 });
  });
  it("an agent not in the city gets no spot", () => {
    const m = podiumSpots([dec("1", "ghost"), dec("2", "a")], ["a"]);
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")).toEqual({ x: 22, y: 11 });
  });
});

describe("lampOf", () => {
  const a = (activity: AgentView["activity"]): AgentView => ({ ...agent("a", "hq"), activity });
  it("yellow beats red beats green, idle and stopped are grey", () => {
    expect(lampOf(a("writing"), [dec("1", "a")], ["a"])).toBe(0xe0b020);
    expect(lampOf(a("writing"), [], ["a"])).toBe(0xc03030);
    expect(lampOf(a("writing"), [], [])).toBe(0x30a040);
    expect(lampOf(a("idle"), [], [])).toBe(0x808080);
    expect(lampOf(a("stopped"), [], [])).toBe(0x808080);
    expect(lampOf(a("idle"), [dec("1", "b")], ["b"])).toBe(0x808080);
  });
});
