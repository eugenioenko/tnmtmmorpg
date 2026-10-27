/**
 * Client-side grid A* for click-to-move. Four-way, uniform cost, matching
 * the server's one-tile move intent. Walkability comes from the tiles the
 * client has been sent, so a path can only be as good as that knowledge;
 * the server still validates every single step.
 */

export interface Tile {
  x: number;
  y: number;
}

const DIRS: readonly Tile[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const absN = (v: number): number => (v < 0 ? -v : v);

class Heap {
  private readonly items: { f: number; i: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(f: number, i: number): void {
    const a = this.items;
    a.push({ f, i });
    let n = a.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (a[p].f <= a[n].f) break;
      [a[p], a[n]] = [a[n], a[p]];
      n = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0].i;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let n = 0;
      for (;;) {
        const l = n * 2 + 1;
        const r = l + 1;
        let m = n;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === n) break;
        [a[m], a[n]] = [a[n], a[m]];
        n = m;
      }
    }
    return top;
  }
}

/**
 * Path from `from` to any tile satisfying `isGoal`, guided toward `toward`.
 * Returns the steps AFTER the start (empty when already at a goal), or null
 * when no goal is reachable within `maxNodes` expansions.
 */
export function findPath(
  from: Tile,
  toward: Tile,
  isGoal: (x: number, y: number) => boolean,
  walkable: (x: number, y: number) => boolean,
  maxNodes = 5000,
): Tile[] | null {
  if (isGoal(from.x, from.y)) return [];
  const xs: number[] = [from.x];
  const ys: number[] = [from.y];
  const gs: number[] = [0];
  const parents: number[] = [-1];
  const seen = new Map<string, number>([[`${from.x},${from.y}`, 0]]);
  const open = new Heap();
  const h = (x: number, y: number): number => absN(x - toward.x) + absN(y - toward.y);
  open.push(h(from.x, from.y), 0);
  let expanded = 0;
  while (open.size > 0) {
    const i = open.pop();
    if (++expanded > maxNodes) return null;
    for (const d of DIRS) {
      const nx = xs[i] + d.x;
      const ny = ys[i] + d.y;
      const key = `${nx},${ny}`;
      if (seen.has(key) || !walkable(nx, ny)) continue;
      const j = xs.length;
      xs.push(nx);
      ys.push(ny);
      gs.push(gs[i] + 1);
      parents.push(i);
      seen.set(key, j);
      if (isGoal(nx, ny)) {
        const path: Tile[] = [];
        for (let k = j; k > 0; k = parents[k]) path.push({ x: xs[k], y: ys[k] });
        return path.reverse();
      }
      open.push(gs[j] + h(nx, ny) * 1.001, j);
    }
  }
  return null;
}

export function chebyshev(a: Tile, b: Tile): number {
  const dx = absN(a.x - b.x);
  const dy = absN(a.y - b.y);
  return dx > dy ? dx : dy;
}
