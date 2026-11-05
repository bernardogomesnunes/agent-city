import { BUILDINGS, PODIUM_SPOTS, type AgentView, type BuildingId, type DecisionView, type Point } from "@agentcity/world/shared";

export type Dir = "up" | "down" | "left" | "right";
export const DIR_VEC: Record<Dir, { x: number; y: number }> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

/** A key press shorter than this turns in place. */
export const TAP_MS = 100;
/** Avatar step: 8 tiles per second walking, 16 with Shift. */
export const WALK_MS = 125;
export const RUN_MS = 62;
/** Agents walk 4 tiles per second. */
export const AGENT_STEP_MS = 250;

export type StepResult =
  | { kind: "turn"; dir: Dir }
  | { kind: "bump"; dir: Dir; ms: number }
  | { kind: "step"; dir: Dir; x: number; y: number; ms: number };

/**
 * Grid-step logic for one walker. The scene calls `press` while a direction key is down and the
 * walker is not mid-step, and `release` when no direction key is down.
 * A tap in a new direction turns for as long as the key stays under TAP_MS. A key in the facing
 * direction steps at once. A blocked step returns `bump`, which plays the walk frame without moving.
 */
export class StepMover {
  private turning: Dir | null = null;

  constructor(
    private readonly isWalkable: (x: number, y: number) => boolean,
    public x = 0,
    public y = 0,
    public facing: Dir = "down",
  ) {}

  place(x: number, y: number, facing: Dir): void {
    this.x = x;
    this.y = y;
    this.facing = facing;
    this.turning = null;
  }

  press(dir: Dir, heldMs: number, running: boolean): StepResult {
    if (heldMs < TAP_MS && (dir !== this.facing || this.turning === dir)) {
      this.facing = dir;
      this.turning = dir;
      return { kind: "turn", dir };
    }
    this.turning = null;
    this.facing = dir;
    const ms = running ? RUN_MS : WALK_MS;
    const nx = this.x + DIR_VEC[dir].x;
    const ny = this.y + DIR_VEC[dir].y;
    if (!this.isWalkable(nx, ny)) return { kind: "bump", dir, ms };
    this.x = nx;
    this.y = ny;
    return { kind: "step", dir, x: nx, y: ny, ms };
  }

  release(): void {
    this.turning = null;
  }
}

/** The building whose rectangle holds tile x, y. */
export function buildingAt(x: number, y: number): BuildingId | null {
  const b = BUILDINGS.find((d) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h);
  return b ? b.id : null;
}

export interface SlotSpot { buildingId: BuildingId; x: number; y: number }

/**
 * Town tile for each agent. Agents in one building take its desk slots in id order.
 * Extra agents stand on the row below the door, spread left and right: x - 1, x + 1, x - 2, ...
 */
export function assignSlots(agents: AgentView[]): Map<string, SlotSpot> {
  const out = new Map<string, SlotSpot>();
  const sorted = [...agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const b of BUILDINGS) {
    const here = sorted.filter((a) => a.buildingId === b.id);
    here.forEach((a, i) => {
      const slot = b.slots[i];
      if (slot) {
        out.set(a.id, { buildingId: b.id, x: slot.x, y: slot.y });
        return;
      }
      const k = i - b.slots.length;
      const off = (Math.floor(k / 2) + 1) * (k % 2 === 0 ? -1 : 1);
      out.set(a.id, { buildingId: b.id, x: b.door.x + off, y: b.door.y + 1 });
    });
  }
  return out;
}

export { PODIUM, PODIUM_SPOTS } from "@agentcity/world/shared";

/**
 * Podium spot for each agent with a decision. Agents take spots in the order of their first
 * decision. Ids missing from `agentIds` are skipped. Agents beyond the 8 spots get none.
 */
export function podiumSpots(decisions: DecisionView[], agentIds: string[]): Map<string, Point> {
  const out = new Map<string, Point>();
  const known = new Set(agentIds);
  for (const d of decisions) {
    if (out.size >= PODIUM_SPOTS.length) break;
    if (!known.has(d.agentId) || out.has(d.agentId)) continue;
    out.set(d.agentId, { ...PODIUM_SPOTS[out.size]! });
  }
  return out;
}

export const LAMP = { yellow: 0xe0b020, red: 0xc03030, green: 0x30a040, grey: 0x808080 } as const;

/** Lamp color: yellow with a decision, else red with failing CI, else green when active, else grey. */
export function lampOf(agent: AgentView, decisions: DecisionView[], failing: string[]): number {
  if (decisions.some((d) => d.agentId === agent.id)) return LAMP.yellow;
  if (failing.includes(agent.id)) return LAMP.red;
  return agent.activity === "idle" || agent.activity === "stopped" ? LAMP.grey : LAMP.green;
}

/** Direction of one grid step from `from` to the neighbouring tile `to`. */
export const dirOf = (from: Point, to: Point): Dir =>
  to.x > from.x ? "right" : to.x < from.x ? "left" : to.y > from.y ? "down" : "up";

/** What advanceAlongPath needs from a walker. The scenes pass their Character. */
export interface PathWalker {
  tx: number;
  ty: number;
  moving: boolean;
  step(tx: number, ty: number, dir: Dir, ms: number, done?: () => void): void;
  face(dir: Dir): void;
}

/**
 * Starts the next step of `path` when the walker stands still. Shifts that tile off the path.
 * After the last step the walker turns to `rest`. Returns true when a step started.
 */
export function advanceAlongPath(w: PathWalker, path: Point[], rest: Dir, ms = AGENT_STEP_MS): boolean {
  if (w.moving || path.length === 0) return false;
  const next = path.shift()!;
  w.step(next.x, next.y, dirOf({ x: w.tx, y: w.ty }, next), ms, () => {
    if (path.length === 0) w.face(rest);
  });
  return true;
}

/**
 * Which HQ desk event a step produces: arriving on the front desk, leaving it, or neither.
 * Steps between two other tiles give null, so a panel opened with H stays open.
 */
export function hqDeskEvent(prev: Point, next: Point, desk: Point): "hq-front-desk" | "hq-away" | null {
  const was = prev.x === desk.x && prev.y === desk.y;
  const is = next.x === desk.x && next.y === desk.y;
  if (is && !was) return "hq-front-desk";
  if (was && !is) return "hq-away";
  return null;
}
