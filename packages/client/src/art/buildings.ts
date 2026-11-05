import { BUILDINGS, TILE, type BuildingDef, type PlotKind } from "@agentcity/world/shared";

/**
 * Prefab buildings drawn in code. Each look has 2 layers of the same size:
 * base (walls seen from above, floor, desks, front face with door) and roof (roof and upper facade).
 * Canvas size is the building rectangle in px plus ROOF_OVERHANG rows on top; place it at (x * 16, y * 16 - 8).
 * Pure module: draws only through `fillStyle` and `fillRect`, so tests can pass a recording fake.
 */

export interface PixelCtx {
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
}

export type BuildingLook = "director" | "hq" | "software" | "visual" | PlotKind;
export const BUILDING_LOOKS: BuildingLook[] = [
  "director", "hq", "software", "visual", "library", "workshop", "exchange", "studio", "house",
];

/** Rows the roof may rise above the building rectangle. */
export const ROOF_OVERHANG = 8;
/** Height of the front face that stays visible when the roof is hidden. */
export const FRONT_FACE = 20;

const OUT = "#202838";
const GLASS = "#78c0f8";
const GLINT = "#f0fbff";
const GOLD = "#f8c838";
const GOLD_DARK = "#c08818";
const DEEP = "#3a3448";
/** Dark screen behind holo signs, charts and tickers. */
const SCREEN = "#1c2438";
/** Translucent ground shadow, drawn right of and below an object. */
export const SHADOW = "rgba(16,24,48,0.32)";
/** Shadow band width in px. */
export const SHADOW_SIZE = 5;

interface Look {
  wall: string; wallLight: string; wallDark: string;
  roof: string; roofLight: string; roofDark: string;
  floor: string; floorLine: string; checker: boolean;
  /** Light strip, door bar and holo sign color. */
  accent: string;
  /** Upper facade height in px, drawn on the roof layer between the roof and the front face. */
  facade: number;
}

const STEEL = { roof: "#8c9cb8", roofLight: "#b8c8dc", roofDark: "#5c6c88" };

const LOOKS: Record<BuildingLook, Look> = {
  director: { wall: "#e4eaf2", wallLight: "#ffffff", wallDark: "#a0acc0", ...STEEL,
    floor: "#d8c0a0", floorLine: "#b89870", checker: false, accent: "#ffd860", facade: 22 },
  hq: { wall: "#5c7090", wallLight: "#8ca4c4", wallDark: "#3c4c6c", roof: "#3c4c78", roofLight: "#6078a8", roofDark: "#283458",
    floor: "#d0d8e8", floorLine: "#a8b4cc", checker: true, accent: "#40e8f0", facade: 0 },
  software: { wall: "#e8eef8", wallLight: "#ffffff", wallDark: "#a8b4c8", roof: "#3c5c98", roofLight: "#6890d0", roofDark: "#28407c",
    floor: "#b8c4d8", floorLine: "#98a4b8", checker: true, accent: "#40e8f0", facade: 24 },
  visual: { wall: "#f4eaf8", wallLight: "#ffffff", wallDark: "#c0a8d0", roof: "#7c50c0", roofLight: "#b088f0", roofDark: "#503090",
    floor: "#e8d4f0", floorLine: "#c8b0d8", checker: false, accent: "#ff70d0", facade: 22 },
  library: { wall: "#e4e8f0", wallLight: "#ffffff", wallDark: "#a8b0c4", ...STEEL,
    floor: "#c8d0e0", floorLine: "#a8b0c8", checker: false, accent: "#a8a0ff", facade: 22 },
  workshop: { wall: "#9ca4b0", wallLight: "#c4ccd8", wallDark: "#646c80", roof: "#6c7488", roofLight: "#949cb0", roofDark: "#484e60",
    floor: "#a0a4b0", floorLine: "#80848f", checker: false, accent: "#ffa040", facade: 20 },
  exchange: { wall: "#d4eee8", wallLight: "#f4fffc", wallDark: "#88b8ac", roof: "#2c8070", roofLight: "#50b0a0", roofDark: "#1c5c50",
    floor: "#f0f0f0", floorLine: "#c8c8d0", checker: true, accent: "#60f080", facade: 20 },
  studio: { wall: "#3c3c50", wallLight: "#5c5c74", wallDark: "#26263a", roof: "#34344a", roofLight: "#54546c", roofDark: "#20202e",
    floor: "#f0d0a0", floorLine: "#d0a878", checker: false, accent: "#ff5070", facade: 18 },
  house: { wall: "#eef4ea", wallLight: "#ffffff", wallDark: "#b0c0a8", ...STEEL,
    floor: "#d8b888", floorLine: "#b09060", checker: false, accent: "#80f0a0", facade: 20 },
};

/** Holo sign icon per look: "#" is the accent, r/y/g/b are paint colors, "." is the sign screen. */
const ICONS: Record<BuildingLook, string[]> = {
  director: ["...#...", "..###..", "#######", ".#####.", ".##.##.", "#.....#"],
  hq: ["##.##.##", "........", "##.##.##", "........", "##....##"],
  software: ["..#...#.#..", ".#...#...#.", "#....#....#", ".#..#....#.", "..#.#...#.."],
  visual: ["..####.", ".#r#y##", "#####g#", "#b##.##", ".#####."],
  library: [".##...##.", "#..#.#..#", "#..#.#..#", "#..#.#..#", ".##.#.##."],
  workshop: ["..#.#..", ".#####.", "##...##", ".#...#.", "##...##", ".#####.", "..#.#.."],
  exchange: [".###.", "#.#..", ".###.", "..#.#", ".###."],
  studio: [".###.", "#####", "#####", "#####", ".###."],
  house: [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."],
};
const PAINT: Record<string, string> = { r: "#f86040", y: "#f8d040", g: "#68d098", b: "#4890f0" };

const PLOT_TEMPLATE = BUILDINGS.find((b) => b.id === "plot-1")!;

function defFor(look: BuildingLook): BuildingDef {
  return BUILDINGS.find((b) => b.id === look) ?? PLOT_TEMPLATE;
}

/** Canvas size in px for both layers of a look. */
export function buildingSize(look: BuildingLook): { w: number; h: number } {
  const b = defFor(look);
  return { w: b.w * TILE, h: b.h * TILE + ROOF_OVERHANG };
}

/** Pixel buffer; shapes get a 2 px outline; flush merges horizontal runs into fillRect calls. */
class Pix {
  private data: (string | null)[];
  constructor(readonly w: number, readonly h: number) {
    this.data = new Array<string | null>(w * h).fill(null);
  }
  rect(x: number, y: number, w: number, h: number, c: string): void {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.data[j * this.w + i] = c;
    }
  }
  /** Outlined box: 2 px OUT border around a fill. */
  box(x: number, y: number, w: number, h: number, c: string): void {
    this.rect(x, y, w, h, OUT);
    this.rect(x + 2, y + 2, w - 4, h - 4, c);
  }
  /** Fills pixels where `inside` holds with `fill(x, y)`; outlines the shape with 2 px OUT. */
  shape(inside: (x: number, y: number) => boolean, fill: (x: number, y: number) => string, outline = true): void {
    const mask = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) mask[y * this.w + x] = inside(x, y) ? 1 : 0;
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < this.w && y < this.h && mask[y * this.w + x] === 1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (at(x, y)) {
          const edge = outline && [-2, -1, 1, 2].some((d) => !at(x + d, y) || !at(x, y + d));
          this.data[y * this.w + x] = edge ? OUT : fill(x, y);
        }
      }
    }
  }
  flush(ctx: PixelCtx): void {
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const c = this.data[y * this.w + x];
        let end = x + 1;
        while (end < this.w && this.data[y * this.w + end] === c) end++;
        if (c) {
          ctx.fillStyle = c;
          ctx.fillRect(x, y, end - x, 1);
        }
        x = end;
      }
    }
  }
}

/** Blends hex colors a and b: t = 0 gives a, t = 1 gives b. */
function mix(a: string, b: string, t: number): string {
  const n = (c: string, i: number) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(n(a, i) + (n(b, i) - n(a, i)) * t).toString(16).padStart(2, "0")).join("");
}
/** The unlit version of a light color, drawn on the base so the glow layer can pulse over it. */
const dim = (c: string): string => mix(c, "#2a3046", 0.55);
const bright = (c: string): string => mix(c, "#ffffff", 0.55);

/** Distance from (x, y) to the segment a-b. */
function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Door and holo sign positions on the front face, shared by the base and glow layers. */
function frontLayout(look: BuildingLook) {
  const b = defFor(look);
  const { w: W, h: H } = buildingSize(look);
  const faceY = H - FRONT_FACE;
  const doorX = (b.door.x - b.x) * TILE;
  const icon = ICONS[look];
  const sw = icon[0]!.length + 4;
  const sh = icon.length + 4;
  const sx = doorX + 18 + sw <= W - 4 ? doorX + 18 : doorX - 2 - sw;
  return { W, H, faceY, doorX, sign: { x: sx, y: faceY + 5, w: sw, h: sh }, icon };
}

function signIcon(p: Pix, look: BuildingLook, lit: boolean): void {
  const { sign, icon } = frontLayout(look);
  const accent = LOOKS[look].accent;
  icon.forEach((row, iy) => [...row].forEach((ch, ix) => {
    if (ch === ".") return;
    const c = ch === "#" ? accent : PAINT[ch]!;
    p.rect(sign.x + 2 + ix, sign.y + 2 + iy, 1, 1, lit ? bright(c) : dim(c));
  }));
}

/** Glass with mullions every 10 px and a glint in the top left. */
function glassBand(p: Pix, x: number, y: number, w: number, h: number, frame: string): void {
  p.box(x, y, w, h, GLASS);
  for (let mx = x + 10; mx < x + w - 4; mx += 10) p.rect(mx, y + 2, 1, h - 4, frame);
  p.rect(x + 3, y + 3, 3, 1, GLINT);
  p.rect(x + 3, y + 4, 1, Math.min(2, h - 6), GLINT);
}

/** Base layer: wall tops seen from above, floor, desks, front face with glass, sliding door and holo sign. */
export function drawBuildingBase(ctx: PixelCtx, look: BuildingLook): void {
  const L = LOOKS[look];
  const b = defFor(look);
  const { W, H, faceY, doorX, sign } = frontLayout(look);
  const p = new Pix(W, H);
  const top = ROOF_OVERHANG;

  p.box(0, top, W, H - top, L.wallLight);
  p.rect(2, H - 4, W - 4, 2, L.wallDark);
  // Floor inside the walls, with the back wall's inner face along the top.
  p.rect(4, top + 4, W - 8, faceY - top - 4, OUT);
  p.rect(6, top + 6, W - 12, faceY - top - 6, L.floor);
  for (let y = top + 6; y < faceY; y++) {
    for (let x = 6; x < W - 6; x++) {
      const line = L.checker ? ((x >> 3) + (y >> 3)) % 2 === 0 : (y - top) % 8 === 0 || (x + ((y >> 3) % 2) * 12) % 24 === 0;
      if (line) p.rect(x, y, 1, 1, L.floorLine);
    }
  }
  p.rect(6, top + 6, W - 12, 8, L.wall);
  p.rect(6, top + 12, W - 12, 2, L.wallDark);
  p.rect(6, top + 11, W - 12, 1, dim(L.accent));

  // Desks: one tile above each slot, white with a screen.
  for (const s of b.slots) {
    const dx = (s.x - b.x) * TILE;
    const dy = (s.y - b.y) * TILE + top;
    p.box(dx + 1, dy - 4, 14, 10, "#d8e0ec");
    p.rect(dx + 3, dy - 2, 10, 2, "#ffffff");
    p.box(dx + 4, dy - 12, 8, 8, "#384058");
    p.rect(dx + 6, dy - 10, 4, 3, "#60e0f0");
  }

  // Front face: light strip, panel seams, glass, sliding door, holo sign.
  p.box(0, faceY, W, FRONT_FACE, L.wall);
  p.rect(2, faceY + 2, W - 4, 2, dim(L.accent));
  p.rect(2, faceY + 4, W - 4, 1, L.wallLight);
  p.rect(2, H - 5, W - 4, 3, L.wallDark);
  for (let x = 24; x < W - 4; x += 24) p.rect(x, faceY + 5, 1, FRONT_FACE - 10, L.wallDark);
  for (let x = 6; x + 14 <= W - 6; x += 24) {
    if (x + 14 > doorX - 4 && x < doorX + 20) continue;
    if (x + 14 > sign.x - 3 && x < sign.x + sign.w + 3) continue;
    glassBand(p, x, faceY + 6, 14, 9, L.wallDark);
  }
  if (look === "exchange") {
    // Vault door.
    const vx = doorX + 8;
    const vy = faceY + 11;
    p.shape((x, y) => Math.hypot(x + 0.5 - vx, y + 0.5 - vy) <= 8.5, (x, y) => (x < vx - 3 && y < vy - 3 ? "#e8eef8" : "#b8c0d0"));
    p.rect(vx - 6, vy, 12, 1, "#7c8698");
    p.rect(vx, vy - 6, 1, 12, "#7c8698");
    p.box(vx - 3, vy - 3, 6, 6, "#e8eef8");
  } else {
    p.box(doorX + 1, faceY + 4, 14, FRONT_FACE - 4, "#284060");
    p.rect(doorX + 3, faceY + 6, 5, FRONT_FACE - 9, "#5890c8");
    p.rect(doorX + 8, faceY + 6, 5, FRONT_FACE - 9, "#5890c8");
    p.rect(doorX + 4, faceY + 7, 1, 3, GLINT);
    p.rect(doorX + 9, faceY + 7, 1, 3, GLINT);
  }
  p.rect(doorX + 3, H - 3, 10, 1, dim(L.accent));
  p.box(sign.x, sign.y, sign.w, sign.h, SCREEN);
  signIcon(p, look, false);

  p.flush(ctx);
}

/** Glow layer: the lit light strip, door bar and sign icon, on the front face only. The village pulses its alpha. */
export function drawBuildingGlow(ctx: PixelCtx, look: BuildingLook): void {
  const L = LOOKS[look];
  const { W, H, faceY, doorX } = frontLayout(look);
  const p = new Pix(W, H);
  p.rect(2, faceY + 2, W - 4, 2, L.accent);
  for (let x = 6; x < W - 6; x += 12) p.rect(x, faceY + 2, 3, 1, bright(L.accent));
  p.rect(doorX + 3, H - 3, 10, 1, L.accent);
  signIcon(p, look, true);
  p.flush(ctx);
}

/** Upper facade between the roof and the front face: glass curtain wall, eave light line, and `inner` drawn on the glass. */
function facade(p: Pix, L: Look, y0: number, y1: number, inner?: (gx: number, gy: number, gw: number, gh: number) => void): void {
  p.box(0, y0, p.w, y1 - y0 + 2, L.wall);
  p.rect(2, y0 + 2, 3, y1 - y0 - 2, L.wallLight);
  p.rect(p.w - 5, y0 + 2, 3, y1 - y0 - 2, L.wallDark);
  const gx = 8;
  const gy = y0 + 8;
  const gw = p.w - 16;
  const gh = y1 - y0 - 12;
  glassBand(p, gx, gy, gw, gh, L.wallDark);
  inner?.(gx, gy, gw, gh);
  // Eave shadow, a deep line and the unlit light line, then a shaded foot.
  p.rect(2, y0 + 2, p.w - 4, 3, L.wallDark);
  p.rect(2, y0 + 2, p.w - 4, 1, DEEP);
  p.rect(2, y0 + 5, p.w - 4, 1, dim(L.accent));
  p.rect(5, y1 - 2, p.w - 10, 2, L.wallDark);
}

/** Flat steel roof with panel seams and light from the top left. */
function flatRoof(L: Look, w: number) {
  return (x: number, y: number): string => {
    if (y < 10 || x < 6) return L.roofLight;
    if (x > w - 8) return L.roofDark;
    if (x % 24 === 0 || y % 20 === 0) return L.roofDark;
    return L.roof;
  };
}

/** 3x5 pixel letters for the studio's ON AIR sign. */
const LETTERS: Record<string, string[]> = {
  O: ["###", "#.#", "#.#", "#.#", "###"],
  N: ["#.#", "###", "###", "###", "#.#"],
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  I: ["#", "#", "#", "#", "#"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  " ": ["..", "..", "..", "..", ".."],
};

/** Roof layer: covers the whole interior from the top down to the front face. */
export function drawBuildingRoof(ctx: PixelCtx, look: BuildingLook): void {
  const L = LOOKS[look];
  const { w: W, h: H } = buildingSize(look);
  const p = new Pix(W, H);
  const faceY = H - FRONT_FACE;
  const fy = faceY - L.facade;
  const cx = W / 2;

  if (look === "hq") {
    // Tower: roof plane with a penthouse on top, then floors of glass, lit and dashboard panes on the front face.
    const roofBottom = 30;
    p.box(0, roofBottom - 2, W, faceY - roofBottom + 4, L.wall);
    p.rect(2, roofBottom, 4, faceY - roofBottom, L.wallLight);
    p.rect(W - 6, roofBottom, 4, faceY - roofBottom, L.wallDark);
    p.rect(2, roofBottom, W - 4, 3, L.wallDark);
    p.rect(2, roofBottom, W - 4, 1, DEEP);
    let k = 0;
    for (let y = roofBottom + 6; y + 12 < faceY; y += 18) {
      p.rect(2, y + 13, W - 4, 2, L.wallDark);
      p.rect(2, y + 15, W - 4, 1, dim(L.accent));
      for (let x = 12; x + 10 < W - 8; x += 16) {
        k++;
        if (k % 5 === 2) {
          p.box(x, y, 10, 12, SCREEN);
          const bars = [2, 5, 3, 7];
          bars.forEach((h, i) => p.rect(x + 2 + i * 2 - (i > 2 ? 1 : 0), y + 10 - h, 1, h, i % 2 ? L.accent : "#60f080"));
        } else if (k % 5 === 4) {
          p.box(x, y, 10, 12, SCREEN);
          for (let i = 0; i < 6; i++) p.rect(x + 2 + i, y + 7 - Math.round(Math.sin(i + k) * 2), 1, 1, L.accent);
          p.rect(x + 2, y + 9, 6, 1, "#384058");
        } else if (k % 3 === 0) {
          p.box(x, y, 10, 12, GOLD);
          p.rect(x + 2, y + 2, 2, 4, "#fff4a0");
        } else {
          p.box(x, y, 10, 12, GLASS);
          p.rect(x + 2, y + 2, 2, 3, GLINT);
          p.rect(x + 6, y + 8, 2, 2, "#4c88c8");
        }
      }
    }
    p.shape(
      (x, y) => y >= 4 && y <= roofBottom && x >= 0 && x < W,
      (x, y) => (y > roofBottom - 5 ? L.roofDark : x < 6 || y < 9 ? "#a8c0e8" : x > W - 8 ? L.roof : L.roofLight),
    );
    p.rect(2, roofBottom - 4, W - 4, 2, dim(L.accent));
    for (let x = 0; x < W; x += 12) p.box(x, 0, 8, 7, L.roofLight);
    // Penthouse with a line-chart screen, a dish and an antenna.
    p.box(cx - 28, 6, 56, 20, L.wall);
    p.rect(cx - 26, 8, 52, 3, L.wallLight);
    p.rect(cx - 26, 21, 52, 3, L.wallDark);
    p.box(cx - 16, 10, 32, 12, SCREEN);
    for (let i = 0; i < 28; i++) p.rect(cx - 14 + i, 18 - Math.round(i / 6 + Math.sin(i / 2) * 1.5), 1, 1, L.accent);
    p.shape((x, y) => Math.hypot(x + 0.5 - (cx - 40), y + 0.5 - 15) <= 6, (x, y) => (x < cx - 41 && y < 14 ? "#ffffff" : "#d8e0f0"));
    p.rect(cx - 41, 14, 2, 2, "#646878");
    p.rect(cx + 20, 0, 2, 8, "#d8e0f0");
    p.rect(cx + 19, 0, 4, 2, "#f05050");
  } else {
    const body = (fill: (x: number, y: number) => string, y0 = 6) =>
      p.shape((x, y) => y >= y0 && y <= fy + 3 && x >= 0 && x < W, fill);

    switch (look) {
      case "director": {
        facade(p, L, fy, faceY, (gx, gy, gw) => {
          // Org chart on the screen behind the glass.
          const ox = gx + Math.floor(gw / 2);
          const ink = "#ffffff";
          p.rect(ox - 4, gy + 1, 9, 3, L.accent);
          p.rect(ox, gy + 4, 1, 1, ink);
          p.rect(ox - 22, gy + 5, 45, 1, ink);
          for (const bx of [ox - 26, ox - 4, ox + 18]) p.rect(bx, gy + 6, 9, 3, ink);
        });
        body(flatRoof(L, W));
        // Dome skylight.
        const dx = 34;
        const dy = Math.round(fy / 2) + 2;
        p.shape(
          (x, y) => ((x + 0.5 - dx) / 22) ** 2 + ((y + 0.5 - dy) / 16) ** 2 <= 1,
          (x, y) => (Math.abs(x - dx) % 8 === 0 ? "#d8eef8" : x < dx - 6 && y < dy - 5 ? "#c0e8ff" : x > dx + 10 ? "#4c88c8" : GLASS),
        );
        p.rect(dx - 12, dy - 9, 4, 2, GLINT);
        // Rooftop terrace with deck, planters and loungers.
        p.box(64, 12, W - 74, fy - 18, "#c08850");
        for (let y = 15; y < fy - 8; y += 4) p.rect(66, y, W - 78, 1, "#a06838");
        p.box(68, 16, 10, 10, "#40b080");
        p.rect(70, 18, 3, 3, "#a0f0c0");
        p.box(W - 22, fy - 18, 10, 10, "#40b080");
        p.rect(W - 20, fy - 16, 3, 3, "#f86040");
        p.box(84, 18, 14, 6, "#ffffff");
        p.box(84, 28, 14, 6, "#ffffff");
        p.rect(4, 9, W - 8, 1, dim(L.accent));
        break;
      }
      case "software": {
        facade(p, L, fy, faceY, (gx, gy, gw, gh) => {
          // Server racks behind the glass.
          for (let rx = gx + 3; rx + 9 < gx + gw - 2; rx += 12) {
            p.box(rx, gy + 1, 9, gh - 2, "#283040");
            for (let ly = gy + 3; ly < gy + gh - 3; ly += 3) {
              p.rect(rx + 2, ly, 2, 1, "#60f080");
              p.rect(rx + 5, ly, 1, 1, L.accent);
            }
          }
        });
        // Code ticker under the eave.
        p.rect(8, fy + 6, W - 16, 2, SCREEN);
        for (let x = 10; x < W - 12; x += 3 + ((x * 7) % 5)) p.rect(x, fy + 6, 1 + ((x * 3) % 3), 1, L.accent);
        body((x, y) => (y > fy - 4 ? L.roofDark : x < 6 || y < 12 ? L.roofLight : x > W - 8 ? L.roofDark : L.roof));
        // Vents with grills, joined to the center unit by cable trays.
        for (const vx of [8, W - 28]) {
          p.box(vx, 12, 20, 16, "#c8d0e0");
          for (let y = 15; y < 26; y += 3) p.rect(vx + 3, y, 14, 1, "#7c8698");
        }
        for (const [x0, x1] of [[28, cx - 20], [cx + 20, W - 28]] as const) {
          p.rect(x0, 20, x1 - x0, 3, "#283040");
          for (let x = x0 + 2; x < x1 - 1; x += 4) p.rect(x, 21, 1, 1, L.accent);
        }
        p.box(cx - 20, 4, 40, 28, "#405070");
        p.rect(cx - 16, 8, 32, 20, "#1c2438");
        for (let i = 0; i < 4; i++) p.rect(cx - 13 + (i % 2) * 3, 11 + i * 4, 8 + ((i * 7) % 14), 2, i === 2 ? "#60f080" : L.accent);
        p.rect(cx + 8, 23, 4, 2, "#ffffff");
        p.rect(cx - 3, 32, 6, Math.max(0, fy - 34), "#405070");
        break;
      }
      case "visual": {
        facade(p, L, fy, faceY, (gx, gy, gw, gh) => {
          const paints = Object.values(PAINT);
          for (let i = 0; i < 6; i++) p.rect(gx + 6 + i * Math.floor((gw - 12) / 6), gy + 2 + (i % 2) * 2, 5, gh - 6, paints[i % 4]!);
        });
        body((x, y) => (y > fy - 3 ? L.accent : x < 6 || y < 10 ? L.roofLight : x > W - 8 ? DEEP : L.roofDark));
        // Curved roof painted as a giant color palette.
        const rx = W * 0.32;
        const ry = fy - 8;
        const rainbow = ["#f86040", "#f8c838", "#68d098", "#40e8f0", "#4890f0", "#a868e0", "#ff70d0"];
        p.shape(
          (x, y) => y <= fy - 2 && ((x - cx) / rx) ** 2 + ((y - (fy - 2)) / ry) ** 2 <= 1,
          (x, y) => {
            const band = Math.floor((x - (cx - rx)) / 9);
            const c = rainbow[((band % rainbow.length) + rainbow.length) % rainbow.length]!;
            if ((x - Math.round(cx - rx)) % 9 === 0) return "#ffffff";
            if (y < fy - ry * 0.6) return mix(c, "#ffffff", 0.3);
            return x > cx + rx * 0.5 ? mix(c, "#202838", 0.25) : c;
          },
        );
        p.box(cx - 3, 0, 6, 12, L.accent);
        break;
      }
      case "library": {
        facade(p, L, fy, faceY, (gx, gy, gw, gh) => {
          // Shelves of data crystals behind the glass.
          for (let y = gy + 2; y + 3 < gy + gh; y += 4) {
            p.rect(gx + 2, y + 3, gw - 4, 1, "#a8b0c4");
            for (let x = gx + 4; x < gx + gw - 4; x += 5) p.rect(x, y, 2, 3, (x + y) % 3 ? L.accent : "#40e8f0");
          }
        });
        for (let x = 8; x < W - 8; x += 16) {
          p.rect(x, fy + 6, 4, faceY - fy - 6, "#c0e8ff");
          p.rect(x + 3, fy + 6, 1, faceY - fy - 6, GLASS);
        }
        body(flatRoof(L, W));
        // Crystal garden on the roof.
        for (const [x0, y0, c] of [[20, 18, L.accent], [36, 28, "#40e8f0"], [cx, 16, "#a868e0"], [W - 36, 30, L.accent], [W - 20, 18, "#40e8f0"]] as const) {
          p.shape(
            (x, y) => Math.abs(x + 0.5 - x0) + Math.abs(y + 0.5 - y0) * 0.6 <= 5,
            (x, y) => (x < x0 && y < y0 ? mix(c, "#ffffff", 0.5) : x > x0 ? mix(c, "#202838", 0.3) : c),
          );
        }
        p.rect(4, 9, W - 8, 1, dim(L.accent));
        break;
      }
      case "workshop": {
        facade(p, L, fy, faceY, (gx, gy, gw, gh) => {
          for (let x = gx + 4; x < gx + gw - 4; x += 14) p.rect(x, gy + gh - 4, 8, 2, L.accent);
        });
        body(flatRoof(L, W));
        // Hazard edge.
        for (let x = 4; x < W - 6; x += 6) p.rect(x, fy - 1, 3, 3, GOLD);
        // 3D printer with a lit print bed.
        p.box(8, 12, 24, 22, "#d8dce8");
        p.box(11, 16, 18, 14, "#40303a");
        p.rect(14, 25, 12, 3, L.accent);
        p.rect(18, 20, 3, 1, "#a0a4b0");
        p.rect(19, 18, 1, 5, "#a0a4b0");
        p.rect(17, 23, 6, 2, bright(L.accent));
        // Robot arm: base, two segments and a claw.
        const [bx, by] = [W - 22, fy - 12];
        const [jx, jy] = [W - 38, 20];
        const [hx, hy] = [W - 28, 10];
        p.shape((x, y) => segDist(x + 0.5, y + 0.5, bx, by, jx, jy) <= 2.5 || segDist(x + 0.5, y + 0.5, jx, jy, hx, hy) <= 2.5,
          (x, y) => (x + y) % 9 === 0 ? "#ffd080" : "#f08830");
        p.shape((x, y) => Math.hypot(x + 0.5 - bx, y + 0.5 - by) <= 6, () => "#646c80");
        p.box(hx - 4, hy - 6, 8, 5, "#646c80");
        // Parts crate.
        p.box(cx - 8, fy - 20, 16, 14, "#b87840");
        for (let i = 2; i < 12; i++) {
          p.rect(cx - 8 + i + 1, fy - 20 + i, 1, 1, "#784c2c");
          p.rect(cx + 7 - i - 1, fy - 20 + i, 1, 1, "#784c2c");
        }
        break;
      }
      case "exchange": {
        facade(p, L, fy, faceY, (gx, gy, gw, gh) => {
          // Price ticker.
          p.rect(gx + 2, gy + 1, gw - 4, gh - 2, SCREEN);
          for (let x = gx + 4; x < gx + gw - 4; x += 4) {
            const h = 1 + ((x * 7) % 4);
            p.rect(x, gy + gh - 2 - h, 2, h, (x * 13) % 3 ? L.accent : "#f86040");
          }
        });
        body((x, y) => (y > fy - 3 ? GOLD : x < 6 || y < 10 ? L.roofLight : x > W - 8 ? L.roofDark : L.roof));
        const r = Math.min(W * 0.26, fy - 4);
        p.shape(
          (x, y) => y <= fy - 2 && Math.hypot(x - cx, y - (fy - 2)) <= r,
          (x, y) => (x < cx - r * 0.3 && y < fy - r * 0.4 ? "#fff080" : x > cx + r * 0.5 ? GOLD_DARK : GOLD),
        );
        p.box(cx - 4, 0, 8, 10, "#fff080");
        break;
      }
      case "studio": {
        facade(p, L, fy, faceY);
        // ON AIR sign.
        const text = "ON AIR";
        const tw = [...text].reduce((n, ch) => n + LETTERS[ch]![0]!.length + 1, -1);
        const sx = Math.round(cx - tw / 2) - 3;
        p.box(sx, fy + 6, tw + 6, 9, "#a01830");
        let lx = sx + 3;
        for (const ch of text) {
          const g = LETTERS[ch]!;
          g.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") p.rect(lx + x, fy + 8 + y, 1, 1, "#ffe0e8"); }));
          lx += g[0]!.length + 1;
        }
        body((x, y) => (y < 10 || x < 6 ? L.roofLight : x > W - 8 ? L.roofDark : L.roof));
        // Light rig: truss with spotlights and their beams.
        p.rect(6, 12, W - 12, 2, "#a0a4b0");
        p.rect(6, 18, W - 12, 2, "#a0a4b0");
        for (let x = 6; x < W - 8; x += 6) p.rect(x, 14, 1, 4, "#a0a4b0");
        for (const x of [14, 34, 54, 74]) {
          for (let k = 0; k < 9; k++) p.rect(x + 3 - (k >> 1), 26 + k, 2 + (k >> 1) * 2, 1, "#5c5c78");
          p.box(x, 20, 8, 7, "#20202e");
          p.rect(x + 2, 24, 4, 2, "#fff4c0");
        }
        // Mic on a boom.
        p.shape((x, y) => segDist(x + 0.5, y + 0.5, W - 12, fy - 2, W - 34, fy - 18) <= 1.2, () => "#a0a4b0", false);
        p.box(W - 40, fy - 24, 8, 9, "#20202e");
        p.rect(W - 38, fy - 22, 4, 1, "#646878");
        p.rect(W - 38, fy - 20, 4, 1, "#646878");
        break;
      }
      case "house": {
        facade(p, L, fy, faceY);
        body(flatRoof(L, W));
        // Solar roof.
        p.shape(
          (x, y) => y >= 4 && y <= fy + 2 && Math.abs(x - cx) <= (y - 4) * 0.9 + 6,
          (x, y) => (y > fy - 3 ? L.roofDark : x % 6 === 0 || (y - 4) % 5 === 0 ? "#6888d0" : x < cx ? "#34509a" : "#2c3c78"),
        );
        // Garden pod.
        const [gx, gy] = [16, fy - 12];
        p.shape(
          (x, y) => ((x + 0.5 - gx) / 10) ** 2 + ((y + 0.5 - gy) / 8) ** 2 <= 1,
          (x, y) => (y < gy - 4 ? "#c0e8ff" : (x * 3 + y) % 7 === 0 ? "#f86040" : (x + y) % 4 === 0 ? "#a0f0c0" : "#40b080"),
        );
        p.rect(gx - 5, gy - 6, 3, 1, GLINT);
        break;
      }
    }
  }
  p.flush(ctx);
}

/** Drop shadow for an object of size w x h: canvas (w + SHADOW_SIZE) x (h + SHADOW_SIZE), placed at the object's origin. */
export function drawDropShadow(ctx: PixelCtx, w: number, h: number): void {
  ctx.fillStyle = SHADOW;
  ctx.fillRect(w, SHADOW_SIZE, SHADOW_SIZE, h);
  ctx.fillRect(SHADOW_SIZE, h, w - SHADOW_SIZE, SHADOW_SIZE);
}

/** Oval ground shadow filling a w x h canvas, one fillRect per row. */
export function drawOvalShadow(ctx: PixelCtx, w: number, h: number): void {
  ctx.fillStyle = SHADOW;
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - h / 2) / (h / 2);
    const half = Math.round((w / 2) * Math.sqrt(1 - dy * dy));
    if (half > 0) ctx.fillRect(Math.round(w / 2 - half), y, half * 2, 1);
  }
}
