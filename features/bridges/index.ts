import {
  definePlugin,
  isCarvedWorld,
  OVERWORLD,
  resolveWorld,
  type InventoryComponent,
  type ItemDef,
  type RecipeDef,
  type WorldAPI,
} from '@game/shared';

/**
 * Bridges, one plank at a time. A Plank Walkway laid on open water beside
 * you turns that tile into core's walkable 'bridge' tile, for good and for
 * everyone: whatever players span stays spanned.
 *
 * Which water? Always the tile ahead in the direction you last stepped, so
 * walking out along your own bridge keeps extending it and nothing is ever
 * laid sideways by surprise. Only before your first step does it guess: the
 * side with the shortest crossing to dry land.
 *
 * Walkways are sawn from any two planks at the sawbench (the professions
 * feature's station) or bought from the trader.
 */

type Dir = 'n' | 's' | 'e' | 'w';

const STEP: Record<Dir, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const DIRS: Dir[] = ['n', 'e', 's', 'w'];
const MAX_SPAN = 40;

export const ITEMS: ItemDef[] = [
  {
    id: 'bridges:walkway',
    name: 'Plank Walkway',
    tags: ['consumable', 'construction', 'tool', 'merchandise'],
    stack: 30,
    value: 6,
    use: 'bridges:lay',
    useLabel: 'Lay',
    icon: '🌉',
    description: 'Lay it on open water beside you to extend a bridge by one tile. Bridges are permanent and shared.',
  },
];

const RECIPES: RecipeDef[] = [
  {
    id: 'bridges:walkway',
    station: 'professions:sawbench',
    inputs: [{ tag: 'plank', count: 2 }],
    outputs: [{ id: 'bridges:walkway', count: 3 }],
    ticks: 20,
  },
];

const last = new Map<number, { x: number; y: number; dir?: Dir }>();

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function say(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

/** Water tiles past (x, y) heading `dir` before something walkable; undefined if none in reach. */
function span(world: WorldAPI, x: number, y: number, dir: Dir, where: string): number | undefined {
  const [dx, dy] = STEP[dir];
  for (let i = 1; i <= MAX_SPAN; i++) {
    if (world.tile(x + dx * i, y + dy * i, where) === 'water') continue;
    return world.walkable(x + dx * i, y + dy * i, where) ? i - 1 : undefined;
  }
  return undefined;
}

/** The water ahead, or before any step the side with the shortest crossing. */
function pickTile(world: WorldAPI, x: number, y: number, where: string, facing: Dir | undefined): [number, number] | undefined {
  const wet = (d: Dir): boolean => world.tile(x + STEP[d][0], y + STEP[d][1], where) === 'water';
  if (facing) return wet(facing) ? [x + STEP[facing][0], y + STEP[facing][1]] : undefined;
  let best: Dir | undefined;
  let bestSpan = Infinity;
  for (const d of DIRS.filter(wet)) {
    const n = span(world, x, y, d, where) ?? MAX_SPAN + 1;
    if (n < bestSpan) {
      bestSpan = n;
      best = d;
    }
  }
  return best && [x + STEP[best][0], y + STEP[best][1]];
}

function lay(world: WorldAPI, id: number, slot: unknown): void {
  const me = world.get(id);
  const inv = me?.components.inventory;
  if (!me || !isInventory(inv) || typeof slot !== 'number' || !Number.isInteger(slot)) return;
  const cell = inv.slots[slot];
  if (!cell || cell.itemId !== 'bridges:walkway' || cell.count <= 0) return;
  const where = me.world ?? OVERWORLD;
  if (isCarvedWorld(resolveWorld(where))) return say(world, id, 'There is no open water to bridge here.', 'bad');
  const target = pickTile(world, me.x, me.y, where, last.get(id)?.dir);
  if (!target) return say(world, id, 'Face open water to lay a walkway: step toward it, then lay.', 'bad');

  const slots = inv.slots.map((s) => ({ ...s }));
  slots[slot].count -= 1;
  if (slots[slot].count <= 0) slots[slot] = { itemId: '', count: 0 };
  world.update(id, { inventory: { ...inv, slots } });
  world.setTile(target[0], target[1], 'bridge', where);
  world.emit('bridges:laid', { entityId: id });

  const dir = DIRS.find((d) => me.x + STEP[d][0] === target[0] && me.y + STEP[d][1] === target[1]);
  const ahead = dir ? span(world, target[0], target[1], dir, where) : undefined;
  if (ahead === 0) say(world, id, 'The last plank meets dry land. The bridge is complete!', 'good');
  else if (ahead !== undefined && ahead <= 3) say(world, id, `${ahead} more to reach the far bank.`);
}

export default definePlugin({
  id: 'bridges',
  items: ITEMS,
  recipes: RECIPES,
  entityKinds: [],

  systems: [
    {
      name: 'bridges:facing',
      fn: (world) => {
        const seen = new Set<number>();
        for (const p of world.query('player')) {
          seen.add(p.id);
          const prev = last.get(p.id);
          if (!prev) {
            last.set(p.id, { x: p.x, y: p.y });
            continue;
          }
          if (prev.x === p.x && prev.y === p.y) continue;
          const dx = p.x - prev.x;
          const dy = p.y - prev.y;
          const dir: Dir | undefined =
            dy === 0 && dx === 1 ? 'e' : dy === 0 && dx === -1 ? 'w' : dx === 0 && dy === 1 ? 's' : dx === 0 && dy === -1 ? 'n' : undefined;
          last.set(p.id, { x: p.x, y: p.y, dir });
        }
        if (last.size > seen.size) for (const id of last.keys()) if (!seen.has(id)) last.delete(id);
      },
    },
  ],

  commands: [
    {
      name: 'bridges:lay',
      fn: (world, args, entityId) => lay(world, entityId, (args as { slot?: unknown } | undefined)?.slot),
    },
  ],

  events: {},
});
