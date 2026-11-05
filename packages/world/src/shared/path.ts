export interface Point { x: number; y: number }

const DIRS: Point[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

/** 4-direction A*. Result excludes `from` and includes `to`. null when unreachable. */
export function findPath(
  from: Point,
  to: Point,
  isWalkable: (x: number, y: number) => boolean,
): Point[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  if (!isWalkable(to.x, to.y)) return null;
  const key = (x: number, y: number) => `${x},${y}`;
  const h = (x: number, y: number) => Math.abs(x - to.x) + Math.abs(y - to.y);
  const g = new Map<string, number>([[key(from.x, from.y), 0]]);
  const prev = new Map<string, Point>();
  const open: Array<{ x: number; y: number; f: number }> = [{ ...from, f: h(from.x, from.y) }];
  const closed = new Set<string>();
  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[best]!.f) best = i;
    const cur = open.splice(best, 1)[0]!;
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (cur.x === to.x && cur.y === to.y) {
      const out: Point[] = [];
      let p: Point = { x: cur.x, y: cur.y };
      while (p.x !== from.x || p.y !== from.y) {
        out.push(p);
        p = prev.get(key(p.x, p.y))!;
      }
      return out.reverse();
    }
    const gc = g.get(ck)!;
    for (const d of DIRS) {
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      const nk = key(nx, ny);
      if (closed.has(nk) || !isWalkable(nx, ny)) continue;
      const ng = gc + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        prev.set(nk, { x: cur.x, y: cur.y });
        open.push({ x: nx, y: ny, f: ng + h(nx, ny) });
      }
    }
  }
  return null;
}
