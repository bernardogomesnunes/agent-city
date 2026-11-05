import { BUILDINGS, type BuildingDef, type BuildingId, type PlotKind } from "@agentcity/world/shared";
import type { Dir } from "./actors.js";

/** What a building is for, as its sign says it. */
export interface PlaceInfo {
  name: string;
  purpose: string;
}

const PURPOSE: Record<"director" | "hq" | "software" | "visual", string> = {
  director: "Who works for you: the boss, managers and workers, and what each one runs.",
  hq: "All settings: agents, projects, APIs, MCP servers, skills, approvals and runs.",
  software: "Developers: code in your linked folders, runs in progress, branches waiting to merge.",
  visual: "Designers: images, slides and video work from the visual agents.",
};

const KIND: Record<PlotKind, PlaceInfo> = {
  library: { name: "Library", purpose: "Skills your agents can load, and what they remember." },
  workshop: { name: "Workshop", purpose: "Projects and the folders agents work in." },
  exchange: { name: "Exchange", purpose: "Spending: the cost of each run and the API connections." },
  studio: { name: "Studio", purpose: "Outside services: MCP servers like Gmail, Drive or YouTube." },
  house: { name: "House", purpose: "A home an agent built." },
};

/** Sign text for a building. A plot shows what was built on it, or that it is empty. */
export function placeInfo(id: BuildingId, kind?: PlotKind): PlaceInfo {
  if (id.startsWith("plot-")) {
    const n = id.slice(5);
    if (!kind) return { name: `Plot ${n}`, purpose: "Empty. An agent with the build tool can build here." };
    return { name: `${KIND[kind].name} (plot ${n})`, purpose: KIND[kind].purpose };
  }
  const def = BUILDINGS.find((b) => b.id === id)!;
  return { name: def.name, purpose: PURPOSE[id as keyof typeof PURPOSE] };
}

const STEP: Record<Dir, { x: number; y: number }> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const inside = (b: BuildingDef, x: number, y: number) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;

/**
 * The building whose sign shows for the avatar at (x, y) facing `dir`:
 * the one it faces from the next tile, else one whose door is within 2 tiles. Null when none.
 */
export function signAt(x: number, y: number, dir: Dir, buildings: BuildingDef[] = BUILDINGS): BuildingId | null {
  const s = STEP[dir];
  const faced = buildings.find((b) => inside(b, x + s.x, y + s.y));
  if (faced) return faced.id;
  let best: { id: BuildingId; d: number } | null = null;
  for (const b of buildings) {
    const d = Math.abs(b.door.x - x) + Math.abs(b.door.y - y);
    if (d <= 2 && (!best || d < best.d)) best = { id: b.id, d };
  }
  return best?.id ?? null;
}
