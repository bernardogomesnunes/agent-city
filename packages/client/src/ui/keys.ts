/** False while a text field has focus: game keys (move, roofs, H) must not fire while the player types. */
export function gameKeysEnabled(active: Element | null): boolean {
  if (!active) return true;
  const tag = active.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return false;
  return !active.hasAttribute("contenteditable");
}

/** Something Esc can close. */
export interface Overlay {
  readonly isOpen: boolean;
  close(): void;
}

/** Open overlays in opening order. Esc closes the most recently opened one. */
export class OverlayStack {
  private readonly open: Overlay[] = [];

  opened(o: Overlay): void {
    this.closed(o);
    this.open.push(o);
  }

  closed(o: Overlay): void {
    const i = this.open.indexOf(o);
    if (i >= 0) this.open.splice(i, 1);
  }

  /** Closes the topmost open overlay. False when none is open. */
  closeTop(): boolean {
    const top = this.open.pop();
    if (!top) return false;
    top.close();
    return true;
  }
}
