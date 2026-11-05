import Phaser from "phaser";
import { PALETTE } from "../art/palette.js";
import { ROOF_TINTS, TILES } from "../art/tiles.js";
import { CHAR_TINTS, SPRITES, type CharTint } from "../art/sprites.js";
import {
  BUILDING_LOOKS, ROOF_OVERHANG, SHADOW_SIZE, buildingSize, drawBuildingBase, drawBuildingGlow, drawBuildingRoof, drawDropShadow, drawOvalShadow,
  type BuildingLook, type PixelCtx,
} from "../art/buildings.js";

const SIZE = 16;
const ROOF_TILES = ["roof_edge", "roof_mid", "roof_ridge"] as const;
const DIRS = ["down", "up", "left", "right"] as const;
type BuildingLayer = "base" | "roof" | "glow";
const DRAW_LAYER = { base: drawBuildingBase, roof: drawBuildingRoof, glow: drawBuildingGlow };

/** Texture key for a roof tile recolored for a building id or plot kind, e.g. `roof_mid_hq`. */
export const roofKey = (tile: (typeof ROOF_TILES)[number], tint: keyof typeof ROOF_TINTS): string => `${tile}_${tint}`;

/** Texture key for a character frame, e.g. `boss_left_1`. */
export const charKey = (tint: CharTint, dir: (typeof DIRS)[number], frame: 0 | 1): string => `${tint}_${dir}_${frame}`;

/** Texture key for a prefab building layer, e.g. `building_hq_roof`. Plots use their kind as the look. */
export const buildingKey = (look: BuildingLook, layer: BuildingLayer): string => `building_${look}_${layer}`;

/** Draws a 16x16 grid into a canvas texture. `swap` maps a grid char to another palette char before lookup. */
export function textureFromGrid(
  scene: Phaser.Scene,
  key: string,
  grid: string[],
  palette: Record<string, string>,
  swap: Record<string, string> = {},
): void {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, SIZE, SIZE);
  if (!tex) throw new Error(`cannot create texture ${key}`);
  const ctx = tex.getContext();
  grid.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      const color = palette[swap[ch] ?? ch];
      if (!color) throw new Error(`texture ${key}: unknown palette char ${ch}`);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    });
  });
  tex.refresh();
}

/** Canvas texture of size w x h drawn by `draw`. */
function drawnTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: (ctx: PixelCtx) => void): void {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, w, h);
  if (!tex) throw new Error(`cannot create texture ${key}`);
  draw(tex.getContext());
  tex.refresh();
}

/** Drop shadow texture keys: `shadow_<look>` per building, `shadow_16` and `shadow_32` for objects, `shadow_char` (oval, 12x5). */
export const shadowKey = (what: BuildingLook | "16" | "32" | "char"): string => `shadow_${what}`;

function buildingTexture(scene: Phaser.Scene, look: BuildingLook, layer: BuildingLayer): void {
  const key = buildingKey(look, layer);
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const { w, h } = buildingSize(look);
  const tex = scene.textures.createCanvas(key, w, h);
  if (!tex) throw new Error(`cannot create texture ${key}`);
  DRAW_LAYER[layer](tex.getContext(), look);
  tex.refresh();
}

// Art preview mock, shown with `?preview=1`: 34 x 24 tiles.
const MOCK_W = 34;
const MOCK_H = 24;
const MOCK_BUILDINGS: Array<{ look: BuildingLook; x: number; y: number }> = [
  { look: "director", x: 1, y: 6 },
  { look: "hq", x: 10, y: 5 },
  { look: "visual", x: 24, y: 6 },
  { look: "software", x: 1, y: 15 },
  { look: "library", x: 12, y: 16 },
  { look: "studio", x: 20, y: 16 },
];

function mockGround(x: number, y: number): string {
  // Cliffs along the top: 2 ledge levels for x < 14, 1 level for x 14 to 21.
  if (x < 14 && y < 5) return ["cliff_top", "cliff_face", "cliff_ledge", "cliff_face", "cliff_base"][y]!;
  if (x >= 14 && x < 22 && y >= 2 && y < 5) return ["cliff_top", "cliff_face", "cliff_base"][y - 2]!;
  const r = y - 2;
  const plaza = (r >= 10 && r <= 12 && x >= 8 && x <= 27) || r === 11 || r === 20
    || (x === 4 && r === 10) || (x === 28 && r === 10) || ((x === 18 || x === 19) && r >= 13 && r <= 19)
    || (x === 5 && r === 19) || (x === 15 && r === 19) || (x === 23 && r === 19);
  if (plaza) return ["path", "path2", "path3"][(x * 7 + y * 3) % 3]!;
  if (x >= 28 && x <= 31 && r >= 17 && r <= 18) return "water0";
  return (x * 5 + y * 11) % 7 === 0 ? "grass2" : "grass";
}

/** Trees by top-left tile, drawn as 2x2. */
const MOCK_TREES: Array<[number, number]> = [[22, 1], [26, 0], [30, 2], [31, 15]];
const MOCK_OBJECTS: Array<[string, number, number]> = [
  ["flowerbed", 8, 10], ["flowerbed", 8, 11], ["flowerbed", 22, 10], ["flowerbed", 22, 11],
  ["flowerbed", 28, 17], ["flowerbed", 29, 17], ["signpost", 7, 12], ["signpost", 27, 14],
  ["sign_library", 11, 20], ["sign_studio", 26, 20], ["flower", 32, 21], ["tallgrass", 0, 23], ["tallgrass", 1, 23],
];

const MOCK_CHARS: Array<[CharTint, number, number]> = [
  ["avatar", 16, 13], ["boss", 6, 13], ["manager", 20, 13], ["worker", 9, 22], ["visual", 25, 14],
];

export class Boot extends Phaser.Scene {
  private roofs: Phaser.GameObjects.Image[] = [];
  private village?: Phaser.GameObjects.Container;
  private sheet?: Phaser.GameObjects.Container;

  constructor() {
    super("Boot");
  }

  create(): void {
    for (const [name, grid] of Object.entries(TILES)) textureFromGrid(this, name, grid, PALETTE);
    for (const tile of ROOF_TILES) {
      for (const [tint, swap] of Object.entries(ROOF_TINTS)) {
        textureFromGrid(this, roofKey(tile, tint as keyof typeof ROOF_TINTS), TILES[tile]!, PALETTE, swap);
      }
    }
    for (const [tint, swap] of Object.entries(CHAR_TINTS)) {
      for (const dir of DIRS) {
        for (const frame of [0, 1] as const) {
          textureFromGrid(this, charKey(tint as CharTint, dir, frame), SPRITES[`char_${dir}_${frame}`]!, PALETTE, swap);
        }
      }
    }
    for (const look of BUILDING_LOOKS) {
      buildingTexture(this, look, "base");
      buildingTexture(this, look, "roof");
      buildingTexture(this, look, "glow");
      const { w, h } = buildingSize(look);
      drawnTexture(this, shadowKey(look), w + SHADOW_SIZE, h + SHADOW_SIZE, (ctx) => drawDropShadow(ctx, w, h));
    }
    for (const n of [16, 32] as const) {
      drawnTexture(this, shadowKey(`${n}`), n + SHADOW_SIZE, n + SHADOW_SIZE, (ctx) => drawDropShadow(ctx, n, n));
    }
    drawnTexture(this, shadowKey("char"), 12, 5, (ctx) => drawOvalShadow(ctx, 12, 5));
    if (new URLSearchParams(window.location.search).has("preview")) this.drawPreview();
    else this.scene.start("Village");
  }

  /** Art preview mock (`?preview=1`), tile sheet on `T`, roofs toggle on `R`. */
  private drawPreview(): void {
    const village = this.add.container(0, 0);
    const water: Phaser.GameObjects.Image[] = [];
    for (let y = 0; y < MOCK_H; y++) {
      for (let x = 0; x < MOCK_W; x++) {
        const img = this.add.image(x * SIZE, y * SIZE, mockGround(x, y)).setOrigin(0);
        if (img.texture.key === "water0") water.push(img);
        village.add(img);
      }
    }
    const at = (key: string, x: number, y: number) => village.add(this.add.image(x, y, key).setOrigin(0));
    // Shadows first, so each object stands on its own shadow.
    for (const [x, y] of MOCK_TREES) at(shadowKey("32"), x * SIZE, y * SIZE);
    for (const [key, x, y] of MOCK_OBJECTS) if (key === "flowerbed" || key === "signpost") at(shadowKey("16"), x * SIZE, y * SIZE);
    for (const b of MOCK_BUILDINGS) at(shadowKey(b.look), b.x * SIZE, b.y * SIZE - ROOF_OVERHANG);
    for (const [x, y] of MOCK_TREES) {
      at("tree_tl", x * SIZE, y * SIZE);
      at("tree_tr", (x + 1) * SIZE, y * SIZE);
      at("tree_bl", x * SIZE, (y + 1) * SIZE);
      at("tree_br", (x + 1) * SIZE, (y + 1) * SIZE);
    }
    for (const [key, x, y] of MOCK_OBJECTS) at(key, x * SIZE, y * SIZE);
    for (const b of MOCK_BUILDINGS) at(buildingKey(b.look, "base"), b.x * SIZE, b.y * SIZE - ROOF_OVERHANG);
    for (const [, x, y] of MOCK_CHARS) at(shadowKey("char"), x * SIZE + 2, y * SIZE + 12);
    const walkers = MOCK_CHARS.map(([tint, x, y]) => {
      const img = this.add.image(x * SIZE, y * SIZE, charKey(tint, "down", 0)).setOrigin(0);
      village.add(img);
      return { img, tint };
    });
    for (const b of MOCK_BUILDINGS) {
      const roof = this.add.image(b.x * SIZE, b.y * SIZE - ROOF_OVERHANG, buildingKey(b.look, "roof")).setOrigin(0);
      this.roofs.push(roof);
      village.add(roof);
    }
    this.village = village;
    this.sheet = this.buildSheet().setVisible(false);
    this.layout();
    this.scale.on("resize", () => this.layout());

    this.input.keyboard?.on("keydown-R", () => this.roofs.forEach((r) => r.setVisible(!r.visible)));
    this.input.keyboard?.on("keydown-T", () => {
      village.setVisible(!village.visible);
      this.sheet?.setVisible(!village.visible);
    });

    let tick = 0;
    this.time.addEvent({
      delay: 400,
      loop: true,
      callback: () => {
        tick++;
        const dir = DIRS[Math.floor(tick / 4) % DIRS.length]!;
        const frame = (tick % 2) as 0 | 1;
        walkers.forEach((w) => w.img.setTexture(charKey(w.tint as CharTint, dir, frame)));
        water.forEach((img) => img.setTexture(frame ? "water1" : "water0"));
      },
    });
  }

  /** Every tile and every character frame at 2x, wrapped to the window width. */
  private buildSheet(): Phaser.GameObjects.Container {
    const sheet = this.add.container(8, 8);
    const keys = [
      ...Object.keys(TILES),
      ...Object.keys(CHAR_TINTS).flatMap((t) => DIRS.flatMap((d) => [0, 1].map((f) => charKey(t as CharTint, d, f as 0 | 1)))),
    ];
    const step = SIZE * 2 + 4;
    const cols = Math.max(4, Math.floor((this.scale.width - 16) / step));
    keys.forEach((key, i) => sheet.add(this.add.image((i % cols) * step, Math.floor(i / cols) * step, key).setOrigin(0).setScale(2)));
    return sheet;
  }

  private layout(): void {
    if (!this.village) return;
    const fit = Math.min(this.scale.width / (MOCK_W * SIZE), this.scale.height / (MOCK_H * SIZE));
    const s = fit >= 1 ? Math.floor(fit) : fit;
    this.village.setScale(s);
    this.village.setPosition(
      Math.floor((this.scale.width - MOCK_W * SIZE * s) / 2),
      Math.floor((this.scale.height - MOCK_H * SIZE * s) / 2),
    );
  }
}
