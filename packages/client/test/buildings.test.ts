import { describe, expect, it } from "vitest";
import {
  BUILDING_LOOKS, FRONT_FACE, ROOF_OVERHANG, SHADOW_SIZE, buildingSize, drawBuildingBase, drawBuildingGlow, drawBuildingRoof,
  drawDropShadow, drawOvalShadow, type BuildingLook, type PixelCtx,
} from "../src/art/buildings.js";

interface Call { color: string; x: number; y: number; w: number; h: number }

function recorder(): { ctx: PixelCtx; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    fillStyle: "" as unknown,
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ color: String(this.fillStyle), x, y, w, h });
    },
  };
  return { ctx, calls };
}

function record(draw: (ctx: PixelCtx, look: BuildingLook) => void, look: BuildingLook): Call[] {
  const { ctx, calls } = recorder();
  draw(ctx, look);
  return calls;
}

describe("ground shadows", () => {
  it("drop shadow draws a right band and a bottom band inside (w + 5) x (h + 5)", () => {
    const { ctx, calls } = recorder();
    drawDropShadow(ctx, 96, 88);
    expect(calls.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
      [96, SHADOW_SIZE, SHADOW_SIZE, 88],
      [SHADOW_SIZE, 88, 96 - SHADOW_SIZE, SHADOW_SIZE],
    ]);
    for (const c of calls) expect(c.color).toMatch(/^rgba\(/);
  });

  it("oval shadow stays inside 12x5 and is widest on the middle row", () => {
    const { ctx, calls } = recorder();
    drawOvalShadow(ctx, 12, 5);
    for (const c of calls) expect(c.x >= 0 && c.x + c.w <= 12 && c.y >= 0 && c.y < 5).toBe(true);
    expect(Math.max(...calls.map((c) => c.w))).toBe(calls.find((c) => c.y === 2)!.w);
  });
});

const EXPECTED: Record<BuildingLook, [number, number]> = {
  director: [112, 104], hq: [176, 136], software: [128, 104], visual: [128, 104],
  library: [96, 88], workshop: [96, 88], exchange: [96, 88], studio: [96, 88], house: [96, 88],
};

describe("building prefabs", () => {
  it("has 9 looks with the rectangle size plus the roof overhang", () => {
    expect(BUILDING_LOOKS).toHaveLength(9);
    for (const look of BUILDING_LOOKS) {
      const [w, h] = EXPECTED[look];
      expect(buildingSize(look), look).toEqual({ w, h });
    }
  });

  for (const look of BUILDING_LOOKS) {
    it(`${look}: both layers draw in bounds with hex colors; base stays below the overhang`, () => {
      const { w, h } = buildingSize(look);
      for (const [layer, draw] of [["base", drawBuildingBase], ["roof", drawBuildingRoof]] as const) {
        const calls = record(draw, look);
        expect(calls.length, `${look} ${layer}`).toBeGreaterThan(50);
        for (const c of calls) {
          expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
          expect(c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0 && c.x + c.w <= w && c.y + c.h <= h, `${look} ${layer} ${JSON.stringify(c)}`).toBe(true);
          if (layer === "base") expect(c.y).toBeGreaterThanOrEqual(ROOF_OVERHANG);
        }
      }
    });

    it(`${look}: roof covers the floor area`, () => {
      const { w, h } = buildingSize(look);
      const covered = new Uint8Array(w * h);
      for (const c of record(drawBuildingRoof, look)) {
        for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) covered[y * w + x] = 1;
      }
      const missing: string[] = [];
      for (let y = ROOF_OVERHANG + 6; y < h - FRONT_FACE; y++) {
        for (let x = 6; x < w - 6; x++) if (!covered[y * w + x]) missing.push(`${x},${y}`);
      }
      expect(missing.slice(0, 5), look).toEqual([]);
    });
  }

  for (const look of BUILDING_LOOKS) {
    it(`${look}: glow layer lights only the front face`, () => {
      const { w, h } = buildingSize(look);
      const calls = record(drawBuildingGlow, look);
      expect(calls.length, look).toBeGreaterThan(10);
      for (const c of calls) {
        expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(c.x >= 0 && c.x + c.w <= w && c.y >= h - FRONT_FACE && c.y + c.h <= h, `${look} ${JSON.stringify(c)}`).toBe(true);
      }
    });
  }

  it("the 9 looks differ", () => {
    const sigs = BUILDING_LOOKS.map((l) => JSON.stringify(record(drawBuildingRoof, l).slice(0, 400)));
    expect(new Set(sigs).size).toBe(9);
  });
});
