import Phaser from "phaser";
import {
  AVATAR_START, BUILDINGS, LAYERS, MAP_H, MAP_W, PODIUM, PODIUM_SPOTS, TILE, findPath, walkable,
  type AgentView, type BuildingDef, type BuildingId, type CityState, type PlotKind, type Point,
} from "@agentcity/world/shared";
import { ROOF_OVERHANG, type BuildingLook } from "../art/buildings.js";
import { StepMover, advanceAlongPath, assignSlots, lampOf, podiumSpots, type Dir, type SlotSpot } from "../actors.js";
import { city } from "../city.js";
import { RoofState } from "../roofs.js";
import { buildingKey, shadowKey } from "./boot.js";
import { Character, STAND_DEPTH, bubbleText, tintFor } from "./character.js";
import { AGENT_CLICK_EVENT, SIGN_EVENT, TOGGLE_ROOFS_EVENT } from "../ui/events.js";
import { signAt } from "../places.js";
import { gameKeysEnabled } from "../ui/keys.js";
import { AvatarInput } from "./input.js";

export const ZOOM = 3;
export const FADE_MS = 250;
const DUST_MS = 600;
const DUST_FRAME_MS = 100;
const WATER_FRAME_MS = 500;
const FLAT_DEPTH = 1;
const SHADOW_DEPTH = 0.5;
const BASE_DEPTH = 2;
const GLOW_DEPTH = 2.1;
const GLOW_MS = 1100;
const ROTOR_MS = 90;
/** Drones fly above every roof. */
const DRONE_DEPTH = 100_000;
const DRONE_LIFT = 18;
const DRONES = 4;
const CAMERA_DRONE_RADIUS = 52;

const ground = (x: number, y: number): string => LAYERS.ground[y]?.[x] ?? "";
const object = (x: number, y: number): string => LAYERS.objects[y]?.[x] ?? "";
const isPath = (x: number, y: number): boolean => ground(x, y) === "p" || ground(x, y) === "k";
const isDoor = (x: number, y: number): boolean => BUILDINGS.some((b) => b.door.x === x && b.door.y === y);
const standDepth = (bottomTileY: number): number => STAND_DEPTH + bottomTileY * TILE - 1;

/** Texture and flips for a ground tile. Paths join their path, plaza and door neighbours. */
export function groundTile(x: number, y: number): { key: string; flipX?: boolean; flipY?: boolean } {
  const c = ground(x, y);
  const hash = (x * 7 + y * 3) % 3;
  switch (c) {
    case "G": return { key: "tallgrass" };
    case "w": return { key: "water0" };
    case "d": return { key: "dirt" };
    case "C": return { key: "cliff_top" };
    case "V": return { key: ground(x, y + 1) === "V" ? "cliff_face" : "cliff_base" };
    case "k": return { key: ["path", "path2", "path3"][hash]! };
    case "p": {
      const near = [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => ground(x + dx!, y + dy!) === "k");
      if (near) return { key: ["path", "path2", "path3"][hash]! };
      const n = isPath(x, y - 1) || isDoor(x, y - 1);
      const s = isPath(x, y + 1);
      const w = isPath(x - 1, y);
      const e = isPath(x + 1, y);
      const count = [n, s, w, e].filter(Boolean).length;
      if (count >= 3) return { key: "path_cross" };
      if (count === 2) {
        if (n && s) return { key: "path_v" };
        if (w && e) return { key: "path_h" };
        return { key: "path_corner", flipX: w, flipY: n };
      }
      if (e) return { key: "path_end" };
      if (w) return { key: "path_end", flipX: true };
      return { key: count === 0 ? "path" : "path_v" };
    }
    default: return { key: (x * 5 + y * 11) % 7 === 0 ? "grass2" : "grass" };
  }
}

interface BuildingArt {
  def: BuildingDef;
  fences: Phaser.GameObjects.Image[];
  sign: Phaser.GameObjects.Image | null;
  roof: Phaser.GameObjects.Image | null;
}

interface TownAgent { view: AgentView; ch: Character; target: SlotSpot; path: Point[] }

/** The town: ground and objects from LAYERS, prefab buildings with removable roofs, the avatar and the agents. */
export class Village extends Phaser.Scene {
  private readonly roofs = new RoofState();
  private readonly built = new Set<BuildingId>();
  private readonly art = new Map<BuildingId, BuildingArt>();
  private readonly agents = new Map<string, TownAgent>();
  private readonly water: Phaser.GameObjects.Image[] = [];
  private readonly drones: Array<{ body: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Image }> = [];
  private cameraDrone?: { body: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Image; cx: number; cy: number };
  private avatar!: Character;
  private mover!: StepMover;
  private controls!: AvatarInput;
  /** The building whose sign shows now. */
  private signId: BuildingId | null = null;

  constructor() {
    super("Village");
  }

  create(): void {
    this.drawGround();
    this.drawObjects();
    for (const b of BUILDINGS) if (!b.id.startsWith("plot-")) this.showBuilding(b.id, b.id as BuildingLook);

    const ok = (x: number, y: number) => walkable(x, y, this.built);
    this.mover = new StepMover(ok, AVATAR_START.x, AVATAR_START.y, "down");
    this.avatar = new Character(this, "avatar", AVATAR_START.x, AVATAR_START.y, "down");
    this.controls = new AvatarInput(this, this.mover, this.avatar, (x, y) => this.arrive(x, y));

    const cam = this.cameras.main;
    cam.setZoom(ZOOM).setBounds(0, 0, MAP_W * TILE, MAP_H * TILE).setRoundPixels(true);
    cam.startFollow(this.avatar.sprite, true, 1, 1, -TILE / 2, -TILE / 2);

    this.input.keyboard?.on("keydown-R", () => {
      if (gameKeysEnabled(document.activeElement)) this.toggleRoofs();
    });
    const onRoofsButton = () => this.toggleRoofs();
    this.game.events.on(TOGGLE_ROOFS_EVENT, onRoofsButton);
    this.events.once("shutdown", () => this.game.events.off(TOGGLE_ROOFS_EVENT, onRoofsButton));
    let frame = 0;
    this.time.addEvent({
      delay: WATER_FRAME_MS, loop: true,
      callback: () => { frame ^= 1; this.water.forEach((w) => w.setTexture(frame ? "water1" : "water0")); },
    });

    this.spawnDrones();

    const unsubscribe = city.subscribe((s, prev) => this.sync(s, prev));
    if (city.state) this.sync(city.state, null);
    this.events.once("shutdown", unsubscribe);
    this.events.on("wake", (_: unknown, data: { from: BuildingId }) => this.leftRoom(data.from));
  }

  update(time: number): void {
    this.controls.update();
    this.updateSign();
    if (this.cameraDrone) {
      const d = this.cameraDrone;
      const a = time / 2600;
      this.placeDrone(d, d.cx + Math.cos(a) * CAMERA_DRONE_RADIUS, d.cy + Math.sin(a) * CAMERA_DRONE_RADIUS * 0.5);
    }
    for (const a of this.agents.values()) this.walk(a);
  }

  /** Hides or shows every town roof (key R and the HUD Roofs button). */
  toggleRoofs(): void {
    this.roofs.toggleAll();
    for (const [id, art] of this.art) art.roof?.setAlpha(this.roofs.hidden(id) ? 0 : 1);
  }

  private drawGround(): void {
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const t = groundTile(x, y);
        const img = this.add.image(x * TILE + TILE / 2, y * TILE + TILE / 2, t.key).setFlip(!!t.flipX, !!t.flipY);
        if (t.key === "water0") this.water.push(img);
      }
    }
  }

  private drawObjects(): void {
    const at = (key: string, x: number, y: number, depth: number) =>
      this.add.image(x * TILE, y * TILE, key).setOrigin(0).setDepth(depth);
    const signs: Array<{ x: number; y: number; img: Phaser.GameObjects.Image }> = [];
    const fences = new Map<string, Phaser.GameObjects.Image>();
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const o = object(x, y);
        if (o === "T") {
          const top = y % 2 === 0;
          at(`tree_${top ? "t" : "b"}${x % 2 === 0 ? "l" : "r"}`, x, y, standDepth(y - (y % 2) + 2));
          if (top && x % 2 === 0) at(shadowKey("32"), x, y, SHADOW_DEPTH);
        } else if (o === "F") at("flower", x, y, FLAT_DEPTH);
        else if (o === "f") fences.set(`${x},${y}`, at("fence", x, y, standDepth(y + 1)));
        else if (o === "s") at("sign", x, y, standDepth(y + 1));
        else if (o === "b") {
          at(shadowKey("16"), x, y, SHADOW_DEPTH);
          at("flowerbed", x, y, FLAT_DEPTH);
        } else if (o === "P") {
          at(shadowKey("16"), x, y, SHADOW_DEPTH);
          signs.push({ x, y, img: at("signpost", x, y, standDepth(y + 1)) });
        }
      }
    }
    at("podium", PODIUM.x, PODIUM.y, standDepth(PODIUM.y + 1));
    for (const def of BUILDINGS) {
      const inside = [...fences].filter(([k]) => {
        const [x, y] = k.split(",").map(Number) as [number, number];
        return x >= def.x && x < def.x + def.w && y >= def.y && y < def.y + def.h;
      }).map(([, img]) => img);
      const dist = (s: { x: number; y: number }) => Math.abs(s.x - def.door.x) + Math.abs(s.y - def.door.y);
      const sign = signs.filter((s) => dist(s) <= 5).sort((a, b) => dist(a) - dist(b))[0];
      this.art.set(def.id, { def, fences: inside, sign: sign?.img ?? null, roof: null });
    }
  }

  private showBuilding(id: BuildingId, look: BuildingLook): void {
    const art = this.art.get(id)!;
    const { def } = art;
    const px = def.x * TILE;
    const py = def.y * TILE - ROOF_OVERHANG;
    art.fences.forEach((f) => f.setVisible(false));
    this.add.image(px, py, shadowKey(look)).setOrigin(0).setDepth(SHADOW_DEPTH);
    this.add.image(px, py, buildingKey(look, "base")).setOrigin(0).setDepth(BASE_DEPTH);
    const glow = this.add.image(px, py, buildingKey(look, "glow")).setOrigin(0).setDepth(GLOW_DEPTH).setAlpha(0.35);
    this.tweens.add({ targets: glow, alpha: 1, duration: GLOW_MS, yoyo: true, repeat: -1, ease: "Sine.easeInOut", delay: (def.x * 131) % GLOW_MS });
    art.roof = this.add.image(px, py, buildingKey(look, "roof")).setOrigin(0)
      .setDepth(STAND_DEPTH + (def.y + def.h) * TILE).setAlpha(this.roofs.hidden(id) ? 0 : 1);
    if (id.startsWith("plot-")) art.sign?.setTexture(`sign_${look}`);
  }

  /** Dust over the plot for 600 ms, then the prefab. */
  private buildPlot(id: BuildingId, kind: PlotKind): void {
    const { def } = this.art.get(id)!;
    const dust: Phaser.GameObjects.Image[] = [];
    for (let y = def.y; y < def.y + def.h; y++) {
      for (let x = def.x; x < def.x + def.w; x++) {
        dust.push(this.add.image(x * TILE, y * TILE, (x + y) % 2 ? "dust1" : "dust0").setOrigin(0)
          .setDepth(STAND_DEPTH + (def.y + def.h) * TILE + 1));
      }
    }
    const flicker = this.time.addEvent({
      delay: DUST_FRAME_MS, loop: true,
      callback: () => dust.forEach((d) => d.setTexture(d.texture.key === "dust0" ? "dust1" : "dust0")),
    });
    this.time.delayedCall(DUST_MS, () => {
      flicker.remove();
      dust.forEach((d) => d.destroy());
      this.showBuilding(id, kind);
    });
  }

  /** Delivery drones flying between random points, and a camera drone circling the visual house. Decoration only. */
  private spawnDrones(): void {
    const make = () => ({
      shadow: this.add.image(0, 0, shadowKey("char")).setDepth(SHADOW_DEPTH).setAlpha(0.6),
      body: this.add.image(0, 0, "drone0").setDepth(DRONE_DEPTH),
    });
    const hop = (d: ReturnType<typeof make>) => {
      const x = Phaser.Math.Between(2, MAP_W - 3) * TILE;
      const y = Phaser.Math.Between(2, MAP_H - 3) * TILE;
      const from = { x: d.shadow.x, y: d.shadow.y };
      const dist = Math.hypot(x - from.x, y - from.y);
      this.tweens.addCounter({
        from: 0, to: 1, duration: 600 + dist * 22, ease: "Sine.easeInOut", delay: Phaser.Math.Between(300, 2500),
        onUpdate: (tw) => {
          const t = tw.getValue() ?? 0;
          this.placeDrone(d, from.x + (x - from.x) * t, from.y + (y - from.y) * t);
        },
        onComplete: () => hop(d),
      });
    };
    for (let i = 0; i < DRONES; i++) {
      const d = make();
      this.placeDrone(d, Phaser.Math.Between(2, MAP_W - 3) * TILE, Phaser.Math.Between(2, MAP_H - 3) * TILE);
      this.drones.push(d);
      hop(d);
    }
    const visual = BUILDINGS.find((b) => b.id === "visual");
    if (visual) {
      const d = make();
      this.cameraDrone = { ...d, cx: (visual.x + visual.w / 2) * TILE, cy: (visual.y + visual.h / 2) * TILE };
      this.drones.push(d);
    }
    let frame = 0;
    this.time.addEvent({
      delay: ROTOR_MS, loop: true,
      callback: () => { frame ^= 1; this.drones.forEach((d) => d.body.setTexture(frame ? "drone1" : "drone0")); },
    });
  }

  /** Puts a drone's ground shadow at (x, y) and the drone above it. */
  private placeDrone(d: { body: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Image }, x: number, y: number): void {
    d.shadow.setPosition(Math.round(x), Math.round(y + 6));
    d.body.setPosition(Math.round(x), Math.round(y - DRONE_LIFT));
  }

  private sync(state: CityState, prev: CityState | null): void {
    for (const p of state.plots) {
      const id = p.id as BuildingId;
      if (!p.kind || this.built.has(id) || !this.art.has(id)) continue;
      this.built.add(id);
      const wasEmpty = prev?.plots.some((q) => q.id === p.id && !q.kind) ?? false;
      if (wasEmpty && this.scene.isActive()) this.buildPlot(id, p.kind);
      else this.showBuilding(id, p.kind);
    }

    const slots = assignSlots(state.agents);
    const ids = new Set(state.agents.map((a) => a.id));
    const podium = podiumSpots(city.decisions, [...ids]);
    const deciding = new Set(city.decisions.map((d) => d.agentId));
    for (const [id, a] of this.agents) {
      if (ids.has(id)) continue;
      a.ch.destroy();
      this.agents.delete(id);
    }
    const asleep = !this.scene.isActive();
    for (const view of state.agents) {
      const spot = podium.get(view.id);
      const target: SlotSpot = spot ? { buildingId: "hq", x: spot.x, y: spot.y } : slots.get(view.id)!;
      let a = this.agents.get(view.id);
      if (!a) {
        a = { view, ch: new Character(this, tintFor(view), target.x, target.y, "up"), target, path: [] };
        const id = view.id;
        a.ch.sprite.setInteractive({ useHandCursor: true }).on("pointerdown", () => this.game.events.emit(AGENT_CLICK_EVENT, id));
        this.agents.set(view.id, a);
      } else if (a.target.x !== target.x || a.target.y !== target.y) {
        a.target = target;
        this.route(a, asleep);
      }
      a.view = view;
      a.ch.setTint(tintFor(view));
      a.ch.setBubble(bubbleText(view));
      a.ch.setLamp(lampOf(view, city.decisions, city.failing));
      a.ch.setAlert(deciding.has(view.id));
    }
  }

  /** A* from the agent's tile to its target. Unreachable or unseen (town asleep): it appears at the target. */
  private route(a: TownAgent, instant: boolean): void {
    const path = instant ? null : findPath({ x: a.ch.tx, y: a.ch.ty }, a.target, (x, y) => walkable(x, y, this.built));
    if (path) {
      a.path = path;
      return;
    }
    a.path = [];
    a.ch.snap(a.target.x, a.target.y, this.restFacing(a.target));
  }

  private walk(a: TownAgent): void {
    advanceAlongPath(a.ch, a.path, this.restFacing(a.target));
  }

  /** Agents at a desk slot or a podium spot face up. Agents waiting outside face down. */
  private restFacing(t: SlotSpot): Dir {
    if (PODIUM_SPOTS.some((s) => s.x === t.x && s.y === t.y)) return "up";
    const def = this.art.get(t.buildingId)?.def;
    return def?.slots.some((s) => s.x === t.x && s.y === t.y) ? "up" : "down";
  }

  private arrive(x: number, y: number): void {
    const b = BUILDINGS.find((d) => d.door.x === x && d.door.y === y);
    if (!b || (b.id.startsWith("plot-") && !this.built.has(b.id))) return;
    this.controls.locked = true;
    // Agents still walking finish at once: the town is not drawn while the room is open.
    for (const a of this.agents.values()) if (a.path.length > 0 || a.ch.moving) this.route(a, true);
    this.cameras.main.fadeOut(FADE_MS, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.signId = null;
      this.game.events.emit(SIGN_EVENT, null);
      this.scene.launch("Room", { buildingId: b.id });
      this.scene.sleep();
    });
  }

  private updateSign(): void {
    const id = this.avatar.moving ? this.signId : signAt(this.mover.x, this.mover.y, this.mover.facing);
    if (id === this.signId) return;
    this.signId = id;
    this.game.events.emit(SIGN_EVENT, id);
  }

  /** Back from a room: one tile below its door, facing down. */
  private leftRoom(from: BuildingId): void {
    const b = this.art.get(from)!.def;
    this.mover.place(b.door.x, b.door.y + 1, "down");
    this.avatar.snap(b.door.x, b.door.y + 1, "down");
    this.controls.locked = false;
    this.cameras.main.fadeIn(FADE_MS, 0, 0, 0);
  }
}
