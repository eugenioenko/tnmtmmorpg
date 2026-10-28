import { OVERWORLD, WORLD_CENTER_X, WORLD_CENTER_Y, type EntityState, type WorldAPI } from '@game/shared';

/**
 * The residents' days. Each keeps a schedule of stops by hour: their post
 * during working hours, a stroll or the inn in the evening, bed at night,
 * and the captain walks the village bounds after dark. The hour comes from
 * the daynight feature's 'daynight:hour'; without it, it is always noon.
 *
 * Walking is a BFS over walkable tiles inside the village box, one step every
 * STEP_TICKS, and only while a player is near enough to see it. A resident
 * in conversation with a player stands still until the player is done.
 */

export type Activity = 'post' | 'stroll' | 'inn' | 'sleep' | 'patrol' | 'gather';

interface Stop {
  from: number;
  activity: Activity;
  at: [number, number];
  radius: number;
  /** What they say when you catch them at it, instead of their greeting. */
  line?: string;
}

const PATROL: [number, number][] = [
  [0, -12],
  [11, -1],
  [3, 13],
  [-11, 1],
];

export const SCHEDULES: Record<string, Stop[]> = {
  elder: [
    { from: 6, activity: 'stroll', at: [0, 3], radius: 4, line: 'A fine morning for old bones. Walk with me a while.' },
    { from: 8, activity: 'post', at: [-3, 4], radius: 1 },
    { from: 17, activity: 'inn', at: [-7, -2], radius: 2, line: 'A cup of cider and a warm hearth. What more does an old man need?' },
    { from: 21, activity: 'sleep', at: [7, 8], radius: 0, line: 'Zzz… hm? Oh, it is you. Can it not wait until morning?' },
  ],
  captain: [
    { from: 6, activity: 'post', at: [-5, -2], radius: 1 },
    { from: 12, activity: 'inn', at: [-8, -2], radius: 1, line: 'Even a captain eats. Speak quickly — the stew is getting cold.' },
    { from: 13, activity: 'post', at: [-5, -2], radius: 1 },
    { from: 20, activity: 'patrol', at: [0, 0], radius: 0, line: 'Night watch. Keep your voice down and your eyes on the treeline.' },
  ],
  alchemist: [
    { from: 7, activity: 'post', at: [9, -1], radius: 1 },
    { from: 19, activity: 'gather', at: [11, 3], radius: 2, line: 'Moonwort only opens after sundown. Mind where you step.' },
    { from: 22, activity: 'sleep', at: [7, -3], radius: 0, line: 'Mmph… the shop is shut. Fine, fine. What do you need?' },
  ],
  trader: [
    { from: 8, activity: 'post', at: [-3, 8], radius: 1 },
    { from: 18, activity: 'inn', at: [-6, -2], radius: 2, line: 'Pull up a stool! Business never sleeps, friend, but it does drink.' },
    { from: 23, activity: 'sleep', at: [-7, 8], radius: 0, line: 'Zzz… a customer? At this hour? …For you, the shop is open.' },
  ],
};

export function stopAt(id: string, hour: number): Stop | undefined {
  const list = SCHEDULES[id];
  if (!list) return undefined;
  let current = list[list.length - 1];
  for (const s of list) if (hour >= s.from) current = s;
  return current;
}

const STEP_TICKS = 3;
const BOX = 26;
const SEE_RANGE = 60;

interface Walker {
  path: [number, number][];
  goal?: [number, number];
  activity?: Activity;
  patrol: number;
  rest: number;
}

const walkers = new Map<number, Walker>();
let hour = 12;
let tick = 0;

export function setHour(h: number): void {
  if (Number.isInteger(h) && h >= 0 && h < 24) hour = h;
}

export function currentStop(id: string): Stop | undefined {
  return stopAt(id, hour);
}

const abs = (n: number): number => (n < 0 ? -n : n);

function bfs(world: WorldAPI, from: EntityState, goal: [number, number]): [number, number][] | undefined {
  const minX = WORLD_CENTER_X - BOX;
  const minY = WORLD_CENTER_Y - BOX;
  const size = BOX * 2 + 1;
  const inside = (x: number, y: number): boolean => x >= minX && y >= minY && x < minX + size && y < minY + size;
  if (!inside(from.x, from.y) || !inside(goal[0], goal[1])) return undefined;
  const key = (x: number, y: number): number => (y - minY) * size + (x - minX);
  const prev = new Int32Array(size * size).fill(-2);
  const start = key(from.x, from.y);
  const target = key(goal[0], goal[1]);
  prev[start] = -1;
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    if (k === target) break;
    const x = (k % size) + minX;
    const y = ((k / size) | 0) + minY;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny)) continue;
      const nk = key(nx, ny);
      if (prev[nk] !== -2 || !world.walkable(nx, ny, OVERWORLD)) continue;
      prev[nk] = k;
      queue.push(nk);
    }
  }
  if (prev[target] === -2) return undefined;
  const path: [number, number][] = [];
  for (let k = target; k !== start; k = prev[k]) path.push([(k % size) + minX, ((k / size) | 0) + minY]);
  return path.reverse();
}

function nearestWalkable(world: WorldAPI, x: number, y: number): [number, number] {
  for (let r = 0; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (world.walkable(x + dx, y + dy, OVERWORLD)) return [x + dx, y + dy];
      }
    }
  }
  return [x, y];
}

function chooseGoal(world: WorldAPI, me: EntityState, stop: Stop, w: Walker): [number, number] | undefined {
  if (stop.activity === 'patrol') {
    const [px, py] = PATROL[w.patrol % PATROL.length];
    const goal = nearestWalkable(world, WORLD_CENTER_X + px, WORLD_CENTER_Y + py);
    if (me.x === goal[0] && me.y === goal[1]) {
      w.patrol++;
      w.rest = 10;
      return undefined;
    }
    return goal;
  }
  const anchor = nearestWalkable(world, WORLD_CENTER_X + stop.at[0], WORLD_CENTER_Y + stop.at[1]);
  const far = abs(me.x - anchor[0]) > stop.radius || abs(me.y - anchor[1]) > stop.radius;
  if (far) return anchor;
  if (stop.radius === 0 || world.rng() > 0.08) return undefined;
  const tx = anchor[0] + (((world.rng() * (stop.radius * 2 + 1)) | 0) - stop.radius);
  const ty = anchor[1] + (((world.rng() * (stop.radius * 2 + 1)) | 0) - stop.radius);
  return world.walkable(tx, ty, OVERWORLD) ? [tx, ty] : undefined;
}

/** One resident's turn: follow its path, or decide where to go next. */
function walk(world: WorldAPI, me: EntityState, id: string, busy: boolean): void {
  let w = walkers.get(me.id);
  if (!w) {
    w = { path: [], patrol: 0, rest: 0 };
    walkers.set(me.id, w);
  }
  const stop = stopAt(id, hour);
  if (!stop || busy) return;
  if (w.activity !== stop.activity) {
    w.activity = stop.activity;
    w.path = [];
    w.goal = undefined;
    w.rest = 0;
  }
  if (w.rest > 0) {
    w.rest--;
    return;
  }
  if (w.path.length === 0) {
    const goal = chooseGoal(world, me, stop, w);
    if (!goal) return;
    const path = bfs(world, me, goal);
    if (!path || path.length === 0) {
      w.rest = 20;
      return;
    }
    w.path = path;
    w.goal = goal;
  }
  const [nx, ny] = w.path[0];
  if (world.move(me.id, nx, ny)) {
    w.path.shift();
    if (w.path.length === 0 && stop.activity !== 'patrol') w.rest = 30;
  } else {
    w.path = [];
    w.rest = 5;
  }
}

/** Called every tick by the town system. */
export function runRoutines(world: WorldAPI, residentId: (e: EntityState) => string | undefined): void {
  tick++;
  if (tick % STEP_TICKS !== 0) return;
  if (!world.hasPlayerNear(WORLD_CENTER_X, WORLD_CENTER_Y, SEE_RANGE, OVERWORLD)) return;
  const busy = new Set<number>();
  for (const p of world.query('player', 'dialog')) {
    const d = p.components.dialog as { npcId?: unknown } | null;
    if (d && typeof d.npcId === 'number') busy.add(d.npcId);
  }
  const seen = new Set<number>();
  for (const e of world.query('resident')) {
    const id = residentId(e);
    if (!id || (e.world ?? OVERWORLD) !== OVERWORLD) continue;
    seen.add(e.id);
    walk(world, e, id, busy.has(e.id));
    const stop = stopAt(id, hour);
    const asleep = stop?.activity === 'sleep' && (walkers.get(e.id)?.path.length ?? 0) === 0;
    if ((e.components['town:asleep'] === true) !== asleep) world.update(e.id, { 'town:asleep': asleep || undefined });
  }
  if (walkers.size > seen.size) for (const id of walkers.keys()) if (!seen.has(id)) walkers.delete(id);
}
