import { describe, expect, it } from "vitest";
import {
  BUILDINGS, HQ_FRONT_DESK, PLOT_KINDS, ROOMS, findPath, roomFor, roomWalkable, type RoomId,
} from "../src/shared/index.js";

const sizes: Record<RoomId, [number, number]> = {
  director: [10, 8], hq: [14, 10], software: [12, 9], visual: [12, 9],
  library: [10, 8], workshop: [10, 8], exchange: [10, 8], studio: [10, 8], house: [10, 8],
};

describe("rooms", () => {
  it("has one room per start building and plot kind, sized per the spec", () => {
    expect(Object.keys(ROOMS).sort()).toEqual(["director", "hq", "software", "visual", ...PLOT_KINDS].sort());
    for (const [id, [w, h]] of Object.entries(sizes)) {
      const r = ROOMS[id as RoomId];
      expect([r.w, r.h], id).toEqual([w, h]);
      expect(r.floor, id).toHaveLength(h);
      for (const row of r.floor) expect(row, id).toMatch(new RegExp(`^[.#DPRE]{${w}}$`));
    }
  });

  it("has one exit mat on the bottom wall", () => {
    for (const r of Object.values(ROOMS)) {
      expect(r.floor.join("").split("E")).toHaveLength(2);
      expect(r.exit.y, r.id).toBe(r.h - 1);
      expect(r.floor[r.exit.y]![r.exit.x]).toBe("E");
    }
  });

  it("has as many slots as the town building, each on floor next to a desk", () => {
    for (const b of BUILDINGS) {
      const r = b.id.startsWith("plot-") ? ROOMS.library : ROOMS[b.id as RoomId];
      expect(r.slots, b.id).toHaveLength(b.slots.length);
    }
    for (const r of Object.values(ROOMS)) {
      for (const s of r.slots) {
        expect(".R", `${r.id} ${s.x},${s.y}`).toContain(r.floor[s.y]![s.x]);
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => r.floor[s.y + dy!]?.[s.x + dx!] === "D");
        expect(near, `${r.id} ${s.x},${s.y}`).toBe(true);
      }
    }
  });

  it("reaches the exit from every slot", () => {
    for (const r of Object.values(ROOMS)) {
      const ok = (x: number, y: number) => roomWalkable(r, x, y);
      for (const s of r.slots) expect(findPath(s, r.exit, ok), `${r.id} ${s.x},${s.y}`).not.toBeNull();
    }
  });

  it("blocks walls, desks and plants", () => {
    const r = ROOMS.director;
    expect(roomWalkable(r, 0, 0)).toBe(false);
    expect(roomWalkable(r, 3, 1)).toBe(false);
    expect(roomWalkable(r, 1, 1)).toBe(false);
    expect(roomWalkable(r, 3, 3)).toBe(true);
    expect(roomWalkable(r, r.exit.x, r.exit.y)).toBe(true);
    expect(roomWalkable(r, -1, 2)).toBe(false);
  });

  it("puts the HQ front desk on floor in front of a desk, off the slots and reachable", () => {
    const r = ROOMS.hq;
    expect(r.floor[HQ_FRONT_DESK.y]![HQ_FRONT_DESK.x]).toBe(".");
    expect(r.floor[HQ_FRONT_DESK.y - 1]![HQ_FRONT_DESK.x]).toBe("D");
    expect(r.slots).not.toContainEqual(HQ_FRONT_DESK);
    expect(findPath({ x: r.exit.x, y: r.exit.y - 1 }, HQ_FRONT_DESK, (x, y) => roomWalkable(r, x, y))).not.toBeNull();
  });

  it("maps buildings to rooms", () => {
    expect(roomFor("hq")).toBe(ROOMS.hq);
    expect(roomFor("plot-2", "studio")).toBe(ROOMS.studio);
    expect(roomFor("plot-2")).toBeNull();
  });
});
