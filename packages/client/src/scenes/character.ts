import Phaser from "phaser";
import { TILE, type AgentView } from "@agentcity/world/shared";
import type { CharTint } from "../art/sprites.js";
import type { Dir } from "../actors.js";
import { charKey, shadowKey } from "./boot.js";

/** Depth base for things that stand up: actors, trees, signposts, fences and roofs sort by their bottom pixel. */
export const STAND_DEPTH = 10;
export const BUBBLE_DEPTH = 1_000_000;
const BUBBLE_TEXT_MAX = 24;

export function tintFor(a: AgentView): CharTint {
  if (a.role === "boss") return "boss";
  if (a.role === "manager") return "manager";
  return a.building === "visual" ? "visual" : "worker";
}

export function bubbleText(a: AgentView): string | null {
  if (a.activity === "idle" && !a.lastText) return null;
  const last = a.lastText ?? "";
  const short = last.length > BUBBLE_TEXT_MAX ? `${last.slice(0, BUBBLE_TEXT_MAX - 1)}~` : last;
  return short ? `${a.activity.replace("_", " ")}\n${short}` : a.activity.replace("_", " ");
}

/**
 * A walking character on the hidden 16 px grid: sprite, oval shadow and an optional speech bubble.
 * `tx`, `ty` is the logical tile; during a step it is already the destination.
 */
export class Character {
  readonly sprite: Phaser.GameObjects.Image;
  private readonly shadow: Phaser.GameObjects.Image;
  private bubble: Phaser.GameObjects.Container | null = null;
  private bubbleKey = "";
  private lamp: Phaser.GameObjects.Rectangle | null = null;
  private alert: Phaser.GameObjects.Text | null = null;
  private marksVisible = true;
  private frame: 0 | 1 = 0;
  moving = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private tint: CharTint,
    public tx: number,
    public ty: number,
    public facing: Dir = "down",
  ) {
    this.shadow = scene.add.image(0, 0, shadowKey("char")).setOrigin(0);
    this.sprite = scene.add.image(0, 0, charKey(tint, facing, 0)).setOrigin(0);
    this.snap(tx, ty);
  }

  setTint(tint: CharTint): void {
    if (tint === this.tint) return;
    this.tint = tint;
    this.redraw();
  }

  snap(tx: number, ty: number, facing = this.facing): void {
    this.scene.tweens.killTweensOf(this.sprite);
    this.tx = tx;
    this.ty = ty;
    this.facing = facing;
    this.moving = false;
    this.frame = 0;
    this.moveTo(tx * TILE, ty * TILE);
    this.redraw();
  }

  face(dir: Dir): void {
    this.facing = dir;
    this.redraw();
  }

  /** Tweens one tile to (tx, ty) in `ms`, alternating the walk frame. */
  step(tx: number, ty: number, dir: Dir, ms: number, done?: () => void): void {
    this.tx = tx;
    this.ty = ty;
    this.facing = dir;
    this.moving = true;
    this.frame = this.frame === 0 ? 1 : 0;
    this.redraw();
    this.scene.tweens.add({
      targets: this.sprite,
      x: tx * TILE,
      y: ty * TILE,
      duration: ms,
      onUpdate: () => this.moveTo(this.sprite.x, this.sprite.y),
      onComplete: () => {
        this.moving = false;
        this.moveTo(tx * TILE, ty * TILE);
        done?.();
      },
    });
  }

  /** Walk frame in place for `ms` (a blocked step). */
  bump(dir: Dir, ms: number, done?: () => void): void {
    this.facing = dir;
    this.moving = true;
    this.frame = this.frame === 0 ? 1 : 0;
    this.redraw();
    this.scene.time.delayedCall(ms, () => {
      this.moving = false;
      done?.();
    });
  }

  setBubble(text: string | null): void {
    const key = text ?? "";
    if (key === this.bubbleKey) return;
    this.bubbleKey = key;
    this.bubble?.destroy();
    this.bubble = null;
    if (!text) return;
    const label = this.scene.add.text(0, 0, text, {
      fontFamily: "monospace", fontSize: "6px", color: "#202838", align: "center", resolution: 4,
      lineSpacing: -1,
    }).setOrigin(0.5, 1);
    const w = Math.ceil(label.width) + 6;
    const h = Math.ceil(label.height) + 4;
    const box = this.scene.add.rectangle(0, 0, w, h, 0xffffff).setStrokeStyle(1, 0x2c50a8).setOrigin(0.5, 1);
    label.setPosition(0, -2);
    this.bubble = this.scene.add.container(0, 0, [box, label]).setDepth(BUBBLE_DEPTH);
    this.moveTo(this.sprite.x, this.sprite.y);
  }

  /** A 4 by 4 lamp just above the head. null removes it. */
  setLamp(color: number | null): void {
    if (color === null) {
      this.lamp?.destroy();
      this.lamp = null;
    } else if (this.lamp) this.lamp.setFillStyle(color);
    else this.lamp = this.scene.add.rectangle(0, 0, 4, 4, color).setStrokeStyle(1, 0x263040).setDepth(BUBBLE_DEPTH).setVisible(this.marksVisible);
    this.moveTo(this.sprite.x, this.sprite.y);
  }

  /** A "!" above the lamp. */
  setAlert(on: boolean): void {
    if (!on) {
      this.alert?.destroy();
      this.alert = null;
    } else if (!this.alert) {
      this.alert = this.scene.add.text(0, 0, "!", {
        fontFamily: "monospace", fontSize: "8px", fontStyle: "bold", color: "#e0b020", stroke: "#263040", strokeThickness: 2, resolution: 4,
      }).setOrigin(0.5, 1).setDepth(BUBBLE_DEPTH).setVisible(this.marksVisible);
    }
    this.moveTo(this.sprite.x, this.sprite.y);
  }

  setVisible(v: boolean): void {
    this.marksVisible = v;
    this.lamp?.setVisible(v);
    this.alert?.setVisible(v);
    this.sprite.setVisible(v);
    this.shadow.setVisible(v);
    this.bubble?.setVisible(v);
  }

  destroy(): void {
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.destroy();
    this.shadow.destroy();
    this.bubble?.destroy();
    this.lamp?.destroy();
    this.alert?.destroy();
  }

  private moveTo(x: number, y: number): void {
    this.sprite.setPosition(x, y);
    // Just under the tile's bottom edge, so a roof whose bottom is this row stays on top.
    const depth = STAND_DEPTH + y + TILE - 0.5;
    this.sprite.setDepth(depth);
    this.shadow.setPosition(x + 2, y + 12).setDepth(depth - 0.1);
    const cx = Math.round(x + TILE / 2);
    // Lamp 4 px above the head, "!" above the lamp, the bubble above both.
    let top = Math.round(y - 1);
    if (this.lamp) {
      this.lamp.setPosition(cx, top - 2);
      top -= 5;
    }
    if (this.alert) {
      this.alert.setPosition(cx, top);
      top -= 9;
    }
    this.bubble?.setPosition(cx, top);
  }

  private redraw(): void {
    this.sprite.setTexture(charKey(this.tint, this.facing, this.frame));
  }
}
