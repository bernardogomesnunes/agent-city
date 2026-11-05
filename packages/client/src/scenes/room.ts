import Phaser from "phaser";
import {
  BUILDINGS, HQ_FRONT_DESK, TILE, findPath, roomFor, roomWalkable,
  type AgentView, type BuildingId, type CityState, type Point, type RoomDef,
} from "@agentcity/world/shared";
import { StepMover, advanceAlongPath, assignSlots, hqDeskEvent, lampOf } from "../actors.js";
import { city } from "../city.js";
import { Character, STAND_DEPTH, bubbleText, tintFor } from "./character.js";
import { AvatarInput } from "./input.js";
import { AGENT_CLICK_EVENT, ROOM_ENTER_EVENT, ROOM_LEAVE_EVENT } from "../ui/events.js";
import { FADE_MS, ZOOM } from "./village.js";

const WANDER_MIN_MS = 4000;
const WANDER_SPAN_MS = 4000;

/** Emitted on `game.events` when the avatar steps onto the HQ room's front desk tile. */
export const HQ_DESK_EVENT = "hq-front-desk";
/** Emitted on `game.events` when the avatar steps off the HQ room's front desk tile. */
export const HQ_AWAY_EVENT = "hq-away";

interface RoomAgent { view: AgentView; ch: Character; slot: number; path: Point[]; nextWander: number }

/** A building's room: its own small map with the agents at their desk slots. */
export class Room extends Phaser.Scene {
  private buildingId: BuildingId = "hq";
  private room!: RoomDef;
  private readonly agents = new Map<string, RoomAgent>();
  private prevTile: Point = { x: 0, y: 0 };
  private avatar!: Character;
  private mover!: StepMover;
  private controls!: AvatarInput;

  constructor() {
    super("Room");
  }

  init(data: { buildingId: BuildingId }): void {
    this.buildingId = data.buildingId;
    this.agents.clear();
  }

  create(): void {
    const kind = city.state?.plots.find((p) => p.id === this.buildingId)?.kind;
    const room = roomFor(this.buildingId, kind);
    if (!room) throw new Error(`no room for ${this.buildingId}`);
    this.room = room;
    this.drawRoom();

    const start = { x: room.exit.x, y: room.exit.y - 1 };
    this.prevTile = start;
    this.mover = new StepMover((x, y) => roomWalkable(room, x, y), start.x, start.y, "up");
    this.avatar = new Character(this, "avatar", start.x, start.y, "up");
    this.controls = new AvatarInput(this, this.mover, this.avatar, (x, y) => this.arrive(x, y));

    const cam = this.cameras.main;
    cam.setZoom(ZOOM).setRoundPixels(true).setBackgroundColor("#000000");
    cam.centerOn((room.w * TILE) / 2, (room.h * TILE) / 2);
    cam.fadeIn(FADE_MS, 0, 0, 0);

    const unsubscribe = city.subscribe((s) => this.sync(s));
    if (city.state) this.sync(city.state);
    this.game.events.emit(ROOM_ENTER_EVENT, this.buildingId);
    this.events.once("shutdown", () => {
      this.game.events.emit(ROOM_LEAVE_EVENT, this.buildingId);
      unsubscribe();
      for (const a of this.agents.values()) a.ch.destroy();
      this.agents.clear();
    });
  }

  update(time: number): void {
    this.controls.update();
    for (const a of this.agents.values()) {
      if (!a.ch.moving && a.path.length === 0 && a.view.activity === "idle" && time >= a.nextWander) this.wander(a);
      advanceAlongPath(a.ch, a.path, "up");
    }
  }

  private drawRoom(): void {
    const r = this.room;
    const at = (key: string, x: number, y: number, depth = 0) =>
      this.add.image(x * TILE, y * TILE, key).setOrigin(0).setDepth(depth);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const c = r.floor[y]![x]!;
        const floor = (x + y) % 2 === 0 ? "room_floor" : "room_floor2";
        if (c === "#") at(r.id === "library" && y === 0 && x > 0 && x < r.w - 1 ? "bookshelf" : "room_wall", x, y);
        else if (c === "R") at("rug", x, y);
        else if (c === "E") at("exit_mat", x, y);
        else at(floor, x, y);
        if (c === "D") at("room_desk", x, y, STAND_DEPTH + (y + 1) * TILE - 1);
        if (c === "P") at("plant", x, y, STAND_DEPTH + (y + 1) * TILE - 1);
      }
    }
  }

  /** Agents assigned to a desk slot of this building, at the room slot with the same index. */
  private sync(state: CityState): void {
    const def = BUILDINGS.find((b) => b.id === this.buildingId)!;
    const slots = assignSlots(state.agents);
    const here = new Map<string, { view: AgentView; slot: number }>();
    for (const view of state.agents) {
      const s = slots.get(view.id)!;
      if (s.buildingId !== this.buildingId) continue;
      const slot = def.slots.findIndex((d) => d.x === s.x && d.y === s.y);
      if (slot >= 0) here.set(view.id, { view, slot });
    }
    for (const [id, a] of this.agents) {
      if (here.has(id)) continue;
      a.ch.destroy();
      this.agents.delete(id);
    }
    for (const [id, { view, slot }] of here) {
      let a = this.agents.get(id);
      const at = this.room.slots[slot]!;
      if (!a) {
        a = { view, ch: new Character(this, tintFor(view), at.x, at.y, "up"), slot, path: [], nextWander: this.nextWander() };
        a.ch.sprite.setInteractive({ useHandCursor: true }).on("pointerdown", () => this.game.events.emit(AGENT_CLICK_EVENT, id));
        this.agents.set(id, a);
      } else if (a.slot !== slot) {
        a.slot = slot;
        a.path = findPath({ x: a.ch.tx, y: a.ch.ty }, at, (x, y) => roomWalkable(this.room, x, y)) ?? [];
      }
      a.view = view;
      a.ch.setTint(tintFor(view));
      a.ch.setBubble(bubbleText(view));
      a.ch.setLamp(lampOf(view, city.decisions, city.failing));
      a.ch.setAlert(city.decisions.some((d) => d.agentId === id));
    }
  }

  /** An idle agent steps to a free slot. */
  private wander(a: RoomAgent): void {
    a.nextWander = this.nextWander();
    const taken = new Set<string>();
    for (const o of this.agents.values()) {
      const end = o.path[o.path.length - 1] ?? { x: o.ch.tx, y: o.ch.ty };
      taken.add(`${end.x},${end.y}`);
    }
    const free = this.room.slots.filter((s) => !taken.has(`${s.x},${s.y}`));
    if (free.length === 0) return;
    const to = free[Math.floor(Math.random() * free.length)]!;
    a.path = findPath({ x: a.ch.tx, y: a.ch.ty }, to, (x, y) => roomWalkable(this.room, x, y)) ?? [];
  }

  private nextWander(): number {
    return this.time.now + WANDER_MIN_MS + Math.random() * WANDER_SPAN_MS;
  }

  private arrive(x: number, y: number): void {
    if (this.buildingId === "hq") {
      const ev = hqDeskEvent(this.prevTile, { x, y }, HQ_FRONT_DESK);
      if (ev === "hq-front-desk") this.game.events.emit(HQ_DESK_EVENT);
      else if (ev === "hq-away") this.game.events.emit(HQ_AWAY_EVENT);
    }
    this.prevTile = { x, y };
    if (x !== this.room.exit.x || y !== this.room.exit.y) return;
    this.controls.locked = true;
    this.cameras.main.fadeOut(FADE_MS, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.stop();
      this.scene.wake("Village", { from: this.buildingId });
    });
  }
}
