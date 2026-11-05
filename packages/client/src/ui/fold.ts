const FOLD_KEY = "agentcity.folded";

/** Which panels the player folded, kept in this browser only. Storage can be missing; then nothing is kept. */
export function loadFolded(panel: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]") as string[]).includes(panel);
  } catch {
    return false;
  }
}

export function saveFolded(panel: string, folded: boolean): void {
  try {
    const list = (JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]") as string[]).filter((p) => p !== panel);
    if (folded) list.push(panel);
    localStorage.setItem(FOLD_KEY, JSON.stringify(list));
  } catch {
    // private window or blocked storage
  }
}
