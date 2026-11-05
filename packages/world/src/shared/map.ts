export const MAP_W = 40;
export const MAP_H = 30;
export const TILE = 16;
export const SCALE = 3;

export type PlotId = `plot-${1 | 2 | 3 | 4 | 5 | 6}`;
export type BuildingId = "director" | "hq" | "software" | "visual" | PlotId;
export const PLOT_KINDS = ["library", "workshop", "exchange", "studio", "house"] as const;
export type PlotKind = (typeof PLOT_KINDS)[number];
export const AGENT_BUILDINGS = ["software", "visual"] as const;
export type AgentActivity =
  | "idle" | "thinking" | "reading" | "writing" | "messaging" | "delegating"
  | "remembering" | "building" | "waiting_approval" | "stopped";

export interface BuildingDef {
  id: BuildingId;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  door: { x: number; y: number };
  slots: Array<{ x: number; y: number }>;
}

const plot = (n: 1 | 2 | 3 | 4 | 5 | 6, x: number, y: number): BuildingDef => ({
  id: `plot-${n}`,
  name: `Plot ${n}`,
  x, y, w: 6, h: 5,
  door: { x: x + 3, y: y + 4 },
  slots: [{ x: x + 1, y: y + 1 }, { x: x + 4, y: y + 1 }, { x: x + 2, y: y + 3 }],
});

export const BUILDINGS: BuildingDef[] = [
  { id: "director", name: "Director's house", x: 3, y: 3, w: 7, h: 6, door: { x: 6, y: 8 },
    slots: [{ x: 5, y: 5 }, { x: 7, y: 5 }] },
  { id: "hq", name: "Headquarters", x: 15, y: 2, w: 11, h: 8, door: { x: 20, y: 9 },
    slots: [{ x: 17, y: 4 }, { x: 19, y: 4 }, { x: 21, y: 4 }, { x: 23, y: 4 }, { x: 17, y: 6 }, { x: 23, y: 6 }] },
  { id: "software", name: "Software house", x: 4, y: 17, w: 8, h: 6, door: { x: 8, y: 22 },
    slots: [{ x: 6, y: 18 }, { x: 9, y: 18 }, { x: 6, y: 20 }, { x: 9, y: 20 }] },
  { id: "visual", name: "Visual house", x: 28, y: 17, w: 8, h: 6, door: { x: 32, y: 22 },
    slots: [{ x: 30, y: 18 }, { x: 33, y: 18 }, { x: 30, y: 20 }, { x: 33, y: 20 }] },
  plot(1, 30, 3),
  plot(2, 30, 10),
  plot(3, 15, 13),
  plot(4, 22, 13),
  plot(5, 15, 21),
  plot(6, 22, 21),
];

export const AVATAR_START = { x: 20, y: 11 };

// Ground: g grass, G tall grass, p path, k cobblestone plaza, w water, d plot dirt,
//   C cliff top (grass edge over rock), V cliff face. Cliffs block.
// Objects: . none, T tree, f fence, F flower, s sign, b flower bed, P signpost.
//   Trees, fences, flower beds and signposts block.
// Building walls, floors and roofs come from BUILDINGS, not from these grids.
export const LAYERS: { ground: string[]; objects: string[] } = {
  ground: [
    "gggggggggggggggggggggggggggggggggggggggg",
    "gCCCCCCCCCCCCCgggggggggggggCCCCCCCCCCCCg",
    "gVVVVVVVVVVVVVgggggggggggggVVVVVVVVVVVVg",
    "ggggggggggggggggggggggggggggggddddddgggg",
    "ggggggggggggggggggggggggggggggddddddgGGg",
    "ggggggggggggggggggggggggggggggddddddggGg",
    "ggggggggggggggggggggggggggggggddddddgggg",
    "ggggggggggggggggggggggggggggggddddddgggg",
    "gggggggggggggggggggggggggggggggggpgggggg",
    "ggggggpggggggggggggggggggggggpppppppppgg",
    "ggggggpgggggkkkkkkkkpkkkkkkkkpddddddgpgg",
    "ggggggppppppkkkkkkkkpkkkkkkkkgddddddgpgg",
    "ggggggggggggkkkkkkkkkkkkkkkkkgddddddgpgg",
    "ggGGgggggggggpgddddddkddddddggddddddgpgg",
    "ggGGGggggggggpgddddddkddddddggddddddgpgg",
    "gggggggggggggpgddddddkddddddgggggpppppgg",
    "gggggggggggggpgddddddkddddddgggggggggpgg",
    "gggggggggggggpgddddddkddddddgggggggggpgg",
    "gggggggggggggpggggpggkgggpgggggggggggpgg",
    "gggggggggggggppppppppkppppppgggggggggpgg",
    "gggggggggggggpgggggggkgggggggggggggggpgg",
    "gggggggggggggpgddddddkddddddgggggggggpgg",
    "gggggggggggggpgddddddkddddddgggggggggpgg",
    "ggggggggppppppgddddddkddddddggggppppppgg",
    "gggggggggggggpgddddddkddddddgggggggggggg",
    "gGGggggggggggpgddddddkddddddgggwwwwggggg",
    "ggGGgggggggggppppppppkpppppgggwwwwwwgggg",
    "ggggggggGGgggggggggggggggggggggwwwwggggg",
    "gggggggggGgggggggggggggggggggggggggggggg",
    "gggggggggggggggggggggggggggggggggggggggg",
  ],
  objects: [
    "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT",
    "T......................................T",
    "T.............b........................T",
    "T..........F..b...............ffffff...T",
    "T.........................TT..f....f...T",
    "T............F............TT..f....f...T",
    "T..........bb...............F.f....f...T",
    "T.............................fff.ff...T",
    "T.........................bb.P.........T",
    "T.........P...P........................T",
    "T.F...........................ffffff...T",
    "T.............................f....f...T",
    "T.............................f....f...T",
    "T..............ffffff.ffffff..f....f...T",
    "T.......TT.....f....f.f....fF.fff.ff...T",
    "T.......TT.....f....f.f....f.P.........T",
    "T.TT...........f....f.f....f...........T",
    "T.TT........F..fff.ff.fff.ff........F..T",
    "T.TT..........P.......P................T",
    "T.TT................................b..T",
    "T...................................b..T",
    "T.b............ffffff.ffffff...........T",
    "T.b............f....f.f....f...........T",
    "T...P..........f....f.f....fP..........T",
    "T..............f....f.f....f.F.........T",
    "T....F........Pfff.ff.fff.ffP..........T",
    "T.........TT................TT.........T",
    "T.........TT................TT.........T",
    "T...............F...F..................T",
    "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT",
  ],
};

const isPlot = (b: BuildingDef): boolean => b.id.startsWith("plot-");

function inRect(b: BuildingDef, x: number, y: number): boolean {
  return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
}

/** The podium prop on the plaza right of the HQ door. It blocks walking. */
export const PODIUM = { x: 23, y: 10 };
/** Where agents with a decision stand, in the order they take them. */
export const PODIUM_SPOTS: readonly { x: number; y: number }[] = [
  { x: 22, y: 11 }, { x: 23, y: 11 }, { x: 24, y: 11 },
  { x: 21, y: 12 }, { x: 22, y: 12 }, { x: 23, y: 12 }, { x: 24, y: 12 }, { x: 25, y: 12 },
];

export function walkable(x: number, y: number, built: ReadonlySet<BuildingId>): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
  const b = BUILDINGS.find((d) => inRect(d, x, y));
  if (b && (!isPlot(b) || built.has(b.id))) {
    if (x === b.door.x && y === b.door.y) return true;
    const ring = x === b.x || y === b.y || x === b.x + b.w - 1 || y === b.y + b.h - 1;
    return !ring;
  }
  if (x === PODIUM.x && y === PODIUM.y) return false;
  const o = LAYERS.objects[y]![x]!;
  if (o === "T" || o === "f" || o === "b" || o === "P") return false;
  const g = LAYERS.ground[y]![x]!;
  return g !== "w" && g !== "C" && g !== "V";
}
