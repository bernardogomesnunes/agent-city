import { describe, it, expect } from "vitest";
import {
  AVATAR_START, BUILDINGS, LAYERS, MAP_H, MAP_W, findPath, walkable,
  type BuildingId,
} from "../src/shared/index.js";

const none: ReadonlySet<BuildingId> = new Set();
const plotIds = BUILDINGS.filter((b) => b.id.startsWith("plot-")).map((b) => b.id);
const all: ReadonlySet<BuildingId> = new Set(plotIds);

describe("map layers", () => {
  it("has 30 rows of 40 chars in both layers", () => {
    for (const layer of [LAYERS.ground, LAYERS.objects]) {
      expect(layer).toHaveLength(MAP_H);
      for (const row of layer) expect(row).toHaveLength(MAP_W);
    }
  });
  it("uses only allowed chars", () => {
    expect(LAYERS.ground.join("")).toMatch(/^[gGpkwdCV]+$/);
    expect(LAYERS.objects.join("")).toMatch(/^[.TfFsbP]+$/);
  });
  it("borders the map with trees", () => {
    const o = LAYERS.objects;
    expect(o[0]).toBe("T".repeat(MAP_W));
    expect(o[MAP_H - 1]).toBe("T".repeat(MAP_W));
    for (const row of o) {
      expect(row[0]).toBe("T");
      expect(row[MAP_W - 1]).toBe("T");
    }
  });
});

describe("buildings", () => {
  it("has the 10 expected ids", () => {
    expect(BUILDINGS.map((b) => b.id)).toEqual([
      "director", "hq", "software", "visual",
      "plot-1", "plot-2", "plot-3", "plot-4", "plot-5", "plot-6",
    ]);
  });
  it("has no overlapping rectangles and stays inside the map", () => {
    for (const a of BUILDINGS) {
      expect(a.x).toBeGreaterThan(0);
      expect(a.y).toBeGreaterThan(0);
      expect(a.x + a.w).toBeLessThan(MAP_W);
      expect(a.y + a.h).toBeLessThan(MAP_H);
      for (const b of BUILDINGS) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} vs ${b.id}`).toBe(true);
      }
    }
  });
  it("puts each door on the bottom wall and slots strictly inside", () => {
    for (const b of BUILDINGS) {
      expect(b.door.y).toBe(b.y + b.h - 1);
      expect(b.door.x).toBeGreaterThan(b.x);
      expect(b.door.x).toBeLessThan(b.x + b.w - 1);
      for (const s of b.slots) {
        expect(s.x).toBeGreaterThan(b.x);
        expect(s.x).toBeLessThan(b.x + b.w - 1);
        expect(s.y).toBeGreaterThan(b.y);
        expect(s.y).toBeLessThan(b.y + b.h - 1);
      }
    }
  });
  it("matches the slot counts", () => {
    const n = Object.fromEntries(BUILDINGS.map((b) => [b.id, b.slots.length]));
    expect(n).toMatchObject({ director: 2, hq: 6, software: 4, visual: 4, "plot-1": 3, "plot-6": 3 });
  });
  it("leaves buildings as plain ground in the grids", () => {
    for (const b of BUILDINGS) {
      for (let y = b.y; y < b.y + b.h; y++) {
        for (let x = b.x; x < b.x + b.w; x++) {
          const ring = x === b.x || y === b.y || x === b.x + b.w - 1 || y === b.y + b.h - 1;
          const g = LAYERS.ground[y]![x]!;
          if (b.id.startsWith("plot-")) expect(g).toBe("d");
          else expect("gp").toContain(g);
          const o = LAYERS.objects[y]![x]!;
          if (!b.id.startsWith("plot-")) expect(o).toBe(".");
          else if (ring && !(x === b.door.x && y === b.door.y)) expect(o).toBe("f");
          else expect(o).toBe(".");
        }
      }
    }
  });
});

describe("walkable", () => {
  const hq = BUILDINGS.find((b) => b.id === "hq")!;
  it("blocks the podium tile (23, 10) and leaves (23, 11) open", () => {
    expect(walkable(23, 10, none)).toBe(false);
    expect(walkable(23, 11, none)).toBe(true);
  });
  it("is false outside the map", () => {
    expect(walkable(-1, 5, none)).toBe(false);
    expect(walkable(5, -1, none)).toBe(false);
    expect(walkable(MAP_W, 5, none)).toBe(false);
    expect(walkable(5, MAP_H, none)).toBe(false);
  });
  it("is false on walls, true on doors and floors", () => {
    expect(walkable(hq.x, hq.y, none)).toBe(false);
    expect(walkable(hq.x + 2, hq.y + hq.h - 1, none)).toBe(false);
    expect(walkable(hq.door.x, hq.door.y, none)).toBe(true);
    expect(walkable(hq.slots[0]!.x, hq.slots[0]!.y, none)).toBe(true);
  });
  it("is false on trees and water, true on the start tile", () => {
    expect(walkable(0, 0, none)).toBe(false);
    const w = LAYERS.ground.flatMap((r, y) => [...r].map((c, x) => [c, x, y] as const)).find(([c]) => c === "w")!;
    expect(walkable(w[1], w[2], none)).toBe(false);
    expect(walkable(AVATAR_START.x, AVATAR_START.y, none)).toBe(true);
  });
  it("treats an unbuilt plot as fenced dirt with an open door gap", () => {
    const p = BUILDINGS.find((b) => b.id === "plot-1")!;
    expect(walkable(p.x, p.y, none)).toBe(false);
    expect(walkable(p.x, p.y + 2, none)).toBe(false);
    expect(walkable(p.door.x, p.door.y, none)).toBe(true);
    expect(walkable(p.x + 2, p.y + 2, none)).toBe(true);
  });
  it("treats a built plot as walls with a door", () => {
    const p = BUILDINGS.find((b) => b.id === "plot-1")!;
    const built = new Set<BuildingId>(["plot-1"]);
    expect(walkable(p.x, p.y, built)).toBe(false);
    expect(walkable(p.x + 1, p.y + p.h - 1, built)).toBe(false);
    expect(walkable(p.door.x, p.door.y, built)).toBe(true);
    expect(walkable(p.x + 2, p.y + 2, built)).toBe(true);
  });
});

describe("reachability from AVATAR_START", () => {
  for (const [label, built] of [["no plots built", none], ["all plots built", all]] as const) {
    it(`reaches every door and slot with ${label}`, () => {
      const ok = (x: number, y: number) => walkable(x, y, built);
      for (const b of BUILDINGS) {
        expect(findPath(AVATAR_START, b.door, ok), `${b.id} door`).not.toBeNull();
        for (const s of b.slots) expect(findPath(AVATAR_START, s, ok), `${b.id} slot ${s.x},${s.y}`).not.toBeNull();
      }
    });
  }
  it("reaches each door over path tiles only (no detour through grass)", () => {
    for (const b of BUILDINGS) {
      expect(LAYERS.ground[b.door.y + 1]![b.door.x]).toBe("p");
    }
    expect(LAYERS.ground[AVATAR_START.y]![AVATAR_START.x]).toBe("p");
  });
});
