import Phaser from "phaser";
import { startCity } from "./city.js";
import { Boot } from "./scenes/boot.js";
import { Room } from "./scenes/room.js";
import { Village } from "./scenes/village.js";
import { mountUi } from "./ui/index.js";
import "./ui/style.css";

/**
 * Phaser needs a nonzero start size: a 0x0 WebGL framebuffer fails with "Incomplete Attachment".
 * A page loaded in a hidden pane has a 0x0 parent, so the game starts on the first frame where it has size.
 */
function start(parent: HTMLElement): void {
  if (parent.clientWidth === 0 || parent.clientHeight === 0) {
    requestAnimationFrame(() => start(parent));
    return;
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: "#1c3a1c",
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: Math.max(window.innerWidth, 320),
      height: Math.max(window.innerHeight, 240),
    },
    scene: [Boot, Village, Room],
  });
  mountUi(game.events);
}

const parent = document.getElementById("game");
if (!parent) throw new Error("missing #game element");
startCity(window.location);
start(parent);
