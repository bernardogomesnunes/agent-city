import Phaser from "phaser";
import type { Dir } from "../actors.js";
import type { StepMover, StepResult } from "../actors.js";
import { gameKeysEnabled } from "../ui/keys.js";
import type { Character } from "./character.js";

const KEYS: Record<Dir, string[]> = { up: ["UP", "W"], down: ["DOWN", "S"], left: ["LEFT", "A"], right: ["RIGHT", "D"] };

/**
 * Arrow keys and WASD driving a StepMover and its Character.
 * The most recently pressed held direction wins. Shift runs.
 */
export class AvatarInput {
  private readonly keys: Array<{ dir: Dir; key: Phaser.Input.Keyboard.Key }> = [];
  private readonly shift: Phaser.Input.Keyboard.Key;
  locked = false;
  /** A key pressed and released between two frames still counts as a tap. */
  private tapped: Dir | null = null;

  constructor(
    scene: Phaser.Scene,
    private readonly mover: StepMover,
    private readonly avatar: Character,
    private readonly onArrive: (x: number, y: number) => void,
  ) {
    const kb = scene.input.keyboard!;
    for (const [dir, names] of Object.entries(KEYS) as Array<[Dir, string[]]>) {
      for (const n of names) {
        // No key capture: Phaser would preventDefault W, A, S, D and the arrows and block typing in text fields.
        const key = kb.addKey(n, false, false);
        key.on("down", () => { if (gameKeysEnabled(document.activeElement)) this.tapped = dir; });
        this.keys.push({ dir, key });
      }
    }
    this.shift = kb.addKey("SHIFT", false, false);
  }

  update(): void {
    const typing = !gameKeysEnabled(document.activeElement);
    if (this.locked || typing) this.tapped = null;
    if (typing) {
      this.mover.release();
      return;
    }
    if (this.locked || this.avatar.moving) return;
    let best: { dir: Dir; key: Phaser.Input.Keyboard.Key } | null = null;
    for (const k of this.keys) if (k.key.isDown && (!best || k.key.timeDown > best.key.timeDown)) best = k;
    if (!best && this.tapped) {
      this.apply(this.mover.press(this.tapped, 0, this.shift.isDown));
      this.tapped = null;
    }
    if (!best) {
      this.mover.release();
      return;
    }
    this.tapped = null;
    this.apply(this.mover.press(best.dir, Math.max(0, best.key.getDuration()), this.shift.isDown));
  }

  private apply(r: StepResult): void {
    if (r.kind === "turn") this.avatar.face(r.dir);
    else if (r.kind === "bump") this.avatar.bump(r.dir, r.ms);
    else this.avatar.step(r.x, r.y, r.dir, r.ms, () => this.onArrive(r.x, r.y));
  }
}
