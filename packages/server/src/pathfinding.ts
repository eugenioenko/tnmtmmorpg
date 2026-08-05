import type { WorldCoord } from '@game/shared';
import type { World } from './world.ts';

/**
 * Bounded grid A* for NPC navigation.
 *
 * Deliberately simple: uniform cost (1 per tile), Manhattan heuristic, a
 * plain array sorted by f as the priority queue. A real open-list heap or
 * a jump-point variant would be faster, but NPC searches are tiny and
 * bounded — `maxSteps` caps the work before a search ever gets expensive,
 * which is the actual requirement (no NPC may pathfind across the whole
 * 10000x10000 world).
 *
 * Returns the path from the start to the goal — first element is the start
 * — or, when the goal is unreachable or `maxSteps` is exhausted, the path
 * to the walkable node that got closest to the goal (possibly just the
 * start itself). Callers take `path[1]` as the first step.
 */

interface PathNode {
  x: number;
  y: number;
  /** Cost from the start (uniform: 1 per tile). */
  g: number;
  /** g + Manhattan distance to the goal; the sort key. */
  f: number;
  parent: PathNode | undefined;
}

const DELTAS: readonly WorldCoord[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function heuristic(x: number, y: number, toX: number, toY: number): number {
  const dx = x > toX ? x - toX : toX - x;
  const dy = y > toY ? y - toY : toY - y;
  return dx + dy;
}

/** Walk the parent chain from the goal (or best) node back to the start. */
function reconstruct(node: PathNode): WorldCoord[] {
  const path: WorldCoord[] = [];
  let current: PathNode | undefined = node;
  while (current) {
    path.push({ x: current.x, y: current.y });
    current = current.parent;
  }
  path.reverse();
  return path;
}

export function findPath(
  world: World,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  maxSteps: number = 30,
): WorldCoord[] {
  if (fromX === toX && fromY === toY) return [{ x: fromX, y: fromY }];

  const start: PathNode = {
    x: fromX,
    y: fromY,
    g: 0,
    f: heuristic(fromX, fromY, toX, toY),
    parent: undefined,
  };
  const open: PathNode[] = [start];
  const visited = new Set<string>([key(fromX, fromY)]);
  let expanded = 0;
  // The walkable node closest to the goal so far — the fallback path target
  // when the search exhausts maxSteps or finds no route.
  let best: PathNode = start;
  let bestH = start.f;

  while (open.length > 0) {
    // Crude priority queue: sort by f on every pop. A few hundred nodes at
    // most, and only for chasing/fleeing NPCs — plenty fast, keep it simple.
    open.sort((a, b) => a.f - b.f);
    const current = open.shift()!;

    if (current.x === toX && current.y === toY) return reconstruct(current);

    expanded++;
    if (expanded > maxSteps) break;

    const h = heuristic(current.x, current.y, toX, toY);
    if (h < bestH) {
      bestH = h;
      best = current;
    }

    for (const delta of DELTAS) {
      const nx = current.x + delta.x;
      const ny = current.y + delta.y;
      const k = key(nx, ny);
      if (visited.has(k)) continue;
      if (!world.isWalkable(nx, ny)) continue; // walls and out-of-bounds
      visited.add(k);
      const g = current.g + 1;
      open.push({
        x: nx,
        y: ny,
        g,
        f: g + heuristic(nx, ny, toX, toY),
        parent: current,
      });
    }
  }

  // Goal unreachable within maxSteps: the closest node we actually reached.
  return reconstruct(best);
}
