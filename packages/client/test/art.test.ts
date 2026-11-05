import { describe, expect, it } from "vitest";
import { PALETTE } from "../src/art/palette.js";
import { ROOF_TINTS, TILES } from "../src/art/tiles.js";
import { CHAR_TINTS, SPRITES } from "../src/art/sprites.js";

const TILE_NAMES = [
  "grass", "grass2", "tallgrass", "path", "path2", "path3", "path_h", "path_v", "path_corner", "path_cross", "path_end", "water0", "water1",
  "tree_tl", "tree_tr", "tree_bl", "tree_br", "flower", "fence", "dirt", "sign",
  "sign_library", "sign_workshop", "sign_exchange", "sign_studio", "sign_house",
  "cliff_top", "cliff_face", "cliff_ledge", "cliff_base", "flowerbed", "signpost", "podium",
  "room_floor", "room_floor2", "room_wall", "room_desk", "plant", "rug", "exit_mat", "bookshelf",
  "wall", "door", "floor", "desk", "roof_edge", "roof_mid", "roof_ridge", "dust0", "dust1", "drone0", "drone1",
];

function checkGrid(name: string, grid: string[]): void {
  expect(grid, name).toHaveLength(16);
  grid.forEach((row, y) => {
    expect(row.length, `${name} row ${y}`).toBe(16);
    for (const ch of row) {
      expect(ch === "." || ch in PALETTE, `${name} row ${y} char ${ch}`).toBe(true);
    }
  });
}

function checkSwap(name: string, swap: Record<string, string>): void {
  for (const [from, to] of Object.entries(swap)) {
    expect(from in PALETTE, `${name} key ${from}`).toBe(true);
    expect(to in PALETTE, `${name} value ${to}`).toBe(true);
  }
}

describe("palette", () => {
  it("has at most 36 single-char #rrggbb entries and no '.'", () => {
    const entries = Object.entries(PALETTE);
    expect(entries.length).toBeLessThanOrEqual(36);
    expect("." in PALETTE).toBe(false);
    for (const [k, v] of entries) {
      expect(k).toHaveLength(1);
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("tiles", () => {
  it("has every named tile", () => {
    expect(Object.keys(TILES).sort()).toEqual([...TILE_NAMES].sort());
  });
  it("every tile is 16x16 of palette chars or '.'", () => {
    for (const [name, grid] of Object.entries(TILES)) checkGrid(name, grid);
  });
  it("roof tints cover every building and plot kind, with palette keys", () => {
    expect(Object.keys(ROOF_TINTS).sort()).toEqual(
      ["director", "exchange", "house", "hq", "library", "software", "studio", "visual", "workshop"],
    );
    for (const [name, swap] of Object.entries(ROOF_TINTS)) checkSwap(name, swap);
  });
  it("one sign grid per plot kind", () => {
    for (const kind of ["library", "workshop", "exchange", "studio", "house"]) {
      checkGrid(`sign_${kind}`, TILES[`sign_${kind}`] ?? []);
    }
  });
});

describe("sprites", () => {
  it("has 4 directions x 2 frames", () => {
    const names = ["down", "up", "left", "right"].flatMap((d) => [0, 1].map((f) => `char_${d}_${f}`));
    expect(Object.keys(SPRITES).sort()).toEqual(names.sort());
  });
  it("every sprite is 16x16 of palette chars or '.'", () => {
    for (const [name, grid] of Object.entries(SPRITES)) checkGrid(name, grid);
  });
  it("character tints use palette keys", () => {
    expect(Object.keys(CHAR_TINTS).sort()).toEqual(["avatar", "boss", "manager", "visual", "worker"]);
    for (const [name, swap] of Object.entries(CHAR_TINTS)) checkSwap(name, swap);
  });
});
