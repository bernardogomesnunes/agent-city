import { describe, it, expect } from "vitest";
import { findPath } from "../src/shared/index.js";

const open = () => true;

describe("findPath", () => {
  it("returns a straight path excluding from and including to", () => {
    expect(findPath({ x: 0, y: 0 }, { x: 3, y: 0 }, open)).toEqual([
      { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
    ]);
  });
  it("returns an empty path when from equals to", () => {
    expect(findPath({ x: 2, y: 2 }, { x: 2, y: 2 }, open)).toEqual([]);
  });
  it("walks around a wall with the shortest length", () => {
    const wall = (x: number, y: number) => !(x === 2 && y >= 0 && y <= 2);
    const p = findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, (x, y) => wall(x, y) && x >= 0 && y >= 0 && y <= 3)!;
    expect(p).toHaveLength(10);
    expect(p.at(-1)).toEqual({ x: 4, y: 0 });
  });
  it("moves in 4 directions only", () => {
    const p = findPath({ x: 0, y: 0 }, { x: 3, y: 3 }, open)!;
    let prev = { x: 0, y: 0 };
    for (const s of p) {
      expect(Math.abs(s.x - prev.x) + Math.abs(s.y - prev.y)).toBe(1);
      prev = s;
    }
    expect(p).toHaveLength(6);
  });
  it("returns null into a closed box", () => {
    const box = (x: number, y: number) => !(x >= 4 && x <= 6 && y >= 4 && y <= 6 && !(x === 5 && y === 5));
    expect(findPath({ x: 0, y: 0 }, { x: 5, y: 5 }, (x, y) => (x === 5 && y === 5) || (box(x, y) && x >= 0 && y >= 0 && x < 10 && y < 10))).toBeNull();
  });
  it("returns null when the target is not walkable", () => {
    expect(findPath({ x: 0, y: 0 }, { x: 1, y: 0 }, (x) => x !== 1)).toBeNull();
  });
});
