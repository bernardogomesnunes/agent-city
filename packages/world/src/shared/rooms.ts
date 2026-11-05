import type { BuildingId, PlotKind } from "./map.js";

export type RoomId = "director" | "hq" | "software" | "visual" | PlotKind;

/**
 * A building's inside, drawn as its own map.
 * Floor chars: `.` floor, `#` wall, `D` desk, `P` plant, `R` rug, `E` exit mat.
 * Walls, desks and plants block. Slots are floor tiles next to a desk, one per town slot, same order.
 */
export interface RoomDef {
  id: RoomId;
  w: number;
  h: number;
  floor: string[];
  exit: { x: number; y: number };
  slots: Array<{ x: number; y: number }>;
}

const room = (id: RoomId, floor: string[], slots: Array<[number, number]>): RoomDef => {
  const y = floor.findIndex((row) => row.includes("E"));
  return {
    id, w: floor[0]!.length, h: floor.length, floor,
    exit: { x: floor[y]!.indexOf("E"), y },
    slots: slots.map(([sx, sy]) => ({ x: sx, y: sy })),
  };
};

const PLOT_FLOOR = [
  "##########",
  "#P.DD.DD.#",
  "#........#",
  "#........#",
  "#.DD..RR.#",
  "#.....RR.#",
  "#P......P#",
  "####E#####",
];
const PLOT_SLOTS: Array<[number, number]> = [[3, 2], [6, 2], [2, 5]];

export const ROOMS: Record<RoomId, RoomDef> = {
  director: room("director", [
    "##########",
    "#P.DD...P#",
    "#........#",
    "#..RRRR..#",
    "#..RRRR..#",
    "#........#",
    "#P......P#",
    "####E#####",
  ], [[3, 2], [4, 2]]),
  hq: room("hq", [
    "##############",
    "#P.DD.DD.DD.P#",
    "#............#",
    "#.DD......DD.#",
    "#............#",
    "#....RRRR....#",
    "#....RRRR....#",
    "#.DD........P#",
    "#............#",
    "######E#######",
  ], [[3, 2], [6, 2], [9, 2], [10, 2], [2, 4], [11, 4]]),
  software: room("software", [
    "############",
    "#P.DD..DD.P#",
    "#..........#",
    "#..........#",
    "#..DD..DD..#",
    "#..........#",
    "#...RRRR...#",
    "#P........P#",
    "#####E######",
  ], [[3, 2], [7, 2], [3, 5], [7, 5]]),
  visual: room("visual", [
    "############",
    "#PDD....DDP#",
    "#..........#",
    "#..........#",
    "#....DD....#",
    "#..........#",
    "#..RRRRRR..#",
    "#P........P#",
    "#####E######",
  ], [[2, 2], [9, 2], [5, 5], [6, 5]]),
  library: room("library", PLOT_FLOOR, PLOT_SLOTS),
  workshop: room("workshop", PLOT_FLOOR, PLOT_SLOTS),
  exchange: room("exchange", PLOT_FLOOR, PLOT_SLOTS),
  studio: room("studio", PLOT_FLOOR, PLOT_SLOTS),
  house: room("house", PLOT_FLOOR, PLOT_SLOTS),
};

/** The HQ room's front desk tile: the floor tile in front of the reception desk. Stepping on it opens the HQ panel. */
export const HQ_FRONT_DESK = { x: 3, y: 8 };

/** The room for a town building: start buildings by id, plots by built kind. null for an unbuilt plot. */
export function roomFor(id: BuildingId, kind?: PlotKind): RoomDef | null {
  if (id.startsWith("plot-")) return kind ? ROOMS[kind] : null;
  return ROOMS[id as RoomId];
}

export function roomWalkable(room: RoomDef, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= room.w || y >= room.h) return false;
  const c = room.floor[y]![x]!;
  return c === "." || c === "R" || c === "E";
}
