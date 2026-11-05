/**
 * Chibi character, 16x16: head rows 1 to 9, body rows 10 to 15.
 * Base colors: hair X, skin s/S, shirt r/R, pants L, shoes M, outline o. CHAR_TINTS recolors them per role.
 */

const HEAD_DOWN = [
  "................",
  ".....oooooo.....",
  "....oXXXXXXo....",
  "...oXXXXXXXXo...",
  "...oXXXXXXXXo...",
  "...oXsXXXXsXo...",
  "...osssssssso...",
  "...osossssoso...",
  "...oSssssssSo...",
  "....oossssoo....",
];

const HEAD_UP = [
  "................",
  ".....oooooo.....",
  "....oXXXXXXo....",
  "...oXXXXXXXXo...",
  "...oXXXXXXXXo...",
  "...oXXXXXXXXo...",
  "...oXXXXXXXXo...",
  "...oXXXXXXXXo...",
  "...oSXXXXXXSo...",
  "....ooXXXXoo....",
];

const BODY_FRONT = [
  "...oRrrrrrrRo...",
  "..osRrrrrrrRso..",
  "...oLLLLLLLLo...",
  "...oLLLooLLLo...",
];

const LEGS_FRONT_0 = [
  "...oMMo..oLLo...",
  "....oo...oMMo...",
];

const LEGS_FRONT_1 = [
  "...oLLo..oMMo...",
  "...oMMo....oo...",
];

const SIDE_LEFT_TOP = [
  "................",
  ".....oooooo.....",
  "....oXXXXXXo....",
  "...oXXXXXXXXo...",
  "...oXXXXXXXXo...",
  "...osXXXXXXXo...",
  "...ossssXXXXo...",
  "...osossSXXXo...",
  "...ossssSXXXo...",
  "....ossssooo....",
  "....oRrrrrRo....",
  "....oRrsrrRo....",
  "....oLLLLLLo....",
];

const SIDE_LEGS_0 = [
  "....oLLooLLo....",
  "...oMMo..oMMo...",
  "...ooo....ooo...",
];

const SIDE_LEGS_1 = [
  "....oLLLLLLo....",
  ".....oMMMMo.....",
  ".....oooooo.....",
];

const mirror = (grid: string[]): string[] => grid.map((row) => [...row].reverse().join(""));

/**
 * Thickens the outline to 2 px on the shadow side (light comes from the top left):
 * a transparent pixel right of or below an outline pixel becomes outline.
 */
export function thickOutline(grid: string[]): string[] {
  return grid.map((row, y) =>
    [...row]
      .map((ch, x) => (ch === "." && (row[x - 1] === "o" || grid[y - 1]?.[x] === "o") ? "o" : ch))
      .join(""),
  );
}

const LEFT_0 = [...SIDE_LEFT_TOP, ...SIDE_LEGS_0];
const LEFT_1 = [...SIDE_LEFT_TOP, ...SIDE_LEGS_1];

export const SPRITES: Record<string, string[]> = {
  char_down_0: thickOutline([...HEAD_DOWN, ...BODY_FRONT, ...LEGS_FRONT_0]),
  char_down_1: thickOutline([...HEAD_DOWN, ...BODY_FRONT, ...LEGS_FRONT_1]),
  char_up_0: thickOutline([...HEAD_UP, ...BODY_FRONT, ...LEGS_FRONT_0]),
  char_up_1: thickOutline([...HEAD_UP, ...BODY_FRONT, ...LEGS_FRONT_1]),
  char_left_0: thickOutline(LEFT_0),
  char_left_1: thickOutline(LEFT_1),
  char_right_0: thickOutline(mirror(LEFT_0)),
  char_right_1: thickOutline(mirror(LEFT_1)),
};

export type CharTint = "avatar" | "boss" | "manager" | "worker" | "visual";

/** Palette swaps applied to the base character. Keys and values are palette chars. */
export const CHAR_TINTS: Record<CharTint, Record<string, string>> = {
  avatar: {},
  boss: { r: "p", R: "P", X: "m", L: "M" },
  manager: { r: "l", R: "L", X: "y", L: "X" },
  worker: { r: "h", R: "H", X: "o", L: "M" },
  visual: { r: "y", R: "x", X: "R", L: "p" },
};
