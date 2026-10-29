import {
  definePlugin,
  OVERWORLD,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  type InventoryComponent,
  type ItemDef,
  type LightComponent,
  type RecipeDef,
  type WorldAPI,
} from '@game/shared';

/**
 * Light against the dark. Night outdoors and caves underground are drawn
 * dark by the client; anything carrying core's `light` component cuts a
 * glowing hole through it. This feature puts light in the world:
 *
 * - Torches, sold by the trader or cut from any log at the sawbench. Use one
 *   to carry it lit (it burns for a while); use another while carrying one to
 *   plant it at your feet for everyone.
 * - Lamps along the village roads, lit for good.
 * - Campfires scattered through the wilds. Resting beside one heals you.
 */

const HELD_MS = 8 * 60_000;
const PLANTED_MS = 20 * 60_000;
const TORCH: LightComponent = { radius: 5, flicker: 0.55 };
const CAMPFIRE: LightComponent = { radius: 5.5, flicker: 0.8, color: 0xff9a40 };
const LAMP: LightComponent = { radius: 4, flicker: 0.12, color: 0xffa94d, intensity: 0.7 };

/** Lamps along the village roads, as offsets from the square. */
const LAMPS: [number, number][] = [
  [-2, -2],
  [2, 2],
  [-9, 2],
  [9, -2],
  [2, -9],
  [-2, 9],
];

/** Village fixtures that glow of their own accord; `light` is core's, so any feature may set it. */
const FIXTURES: Record<string, LightComponent> = {
  'professions:forge': { radius: 4, flicker: 0.7, color: 0xff7a2a },
  'farming:oven': { radius: 3, flicker: 0.5, color: 0xff9a50, intensity: 0.8 },
  'portals:pad': { radius: 2.5, color: 0x9fd8ff, intensity: 0.6 },
};

export interface Held {
  until: number;
}

export const ITEMS: ItemDef[] = [
  {
    id: 'lighting:torch',
    name: 'Torch',
    tags: ['tool', 'consumable', 'merchandise'],
    stack: 20,
    value: 3,
    use: 'lighting:use',
    useLabel: 'Light',
    icon: '🔥',
    description:
      'Pitch-soaked and ready. Use to carry it lit for a few minutes; use another while one burns to plant it at your feet.',
  },
];

const RECIPES: RecipeDef[] = [
  {
    id: 'lighting:torch',
    station: 'professions:sawbench',
    inputs: [{ tag: 'wood', count: 1 }],
    outputs: [{ id: 'lighting:torch', count: 4 }],
    ticks: 15,
  },
];

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function say(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

function heldOf(value: unknown): Held | undefined {
  return typeof value === 'object' && value !== null && typeof (value as Held).until === 'number'
    ? (value as Held)
    : undefined;
}

/** Take one torch from the given slot, or from anywhere in the pack. */
function takeTorch(world: WorldAPI, id: number, slot: unknown): boolean {
  const inv = world.get(id)?.components.inventory;
  if (!isInventory(inv)) return false;
  let at = typeof slot === 'number' && inv.slots[slot]?.itemId === 'lighting:torch' ? slot : -1;
  if (at < 0) at = inv.slots.findIndex((s) => s.itemId === 'lighting:torch' && s.count > 0);
  if (at < 0) return false;
  const slots = inv.slots.map((s) => ({ ...s }));
  slots[at].count -= 1;
  if (slots[at].count <= 0) slots[at] = { itemId: '', count: 0 };
  world.update(id, { inventory: { ...inv, slots } });
  return true;
}

function use(world: WorldAPI, id: number, slot: unknown): void {
  const me = world.get(id);
  if (!me) return;
  const held = heldOf(me.components['lighting:held']);
  if (held) {
    const where = me.world ?? OVERWORLD;
    if (!world.walkable(me.x, me.y, where)) return;
    if (world.queryNear(me.x, me.y, 0, where).some((e) => e.kind === 'lighting:planted')) {
      say(world, id, 'A torch already burns here.');
      return;
    }
    if (!takeTorch(world, id, slot)) return;
    world.spawn(
      'lighting:planted',
      { x: me.x, y: me.y },
      {
        appearance: { emoji: '🔥', scale: 0.75 },
        light: TORCH,
        'lighting:burn': { until: Date.now() + PLANTED_MS },
      },
      where,
    );
    say(world, id, 'You plant a torch in the ground.');
    return;
  }
  if (!takeTorch(world, id, slot)) return;
  world.update(id, {
    'lighting:held': { until: Date.now() + HELD_MS } satisfies Held,
    light: TORCH,
  });
  say(world, id, 'You light a torch. Use another to plant it.');
}

let clock = 0;

/** Burn down carried and planted torches; keep carried light in step after a login. */
function burn(world: WorldAPI): void {
  const now = Date.now();
  for (const p of world.query('lighting:held')) {
    const held = heldOf(p.components['lighting:held']);
    if (!held || held.until <= now) {
      world.update(p.id, { 'lighting:held': undefined, light: undefined });
      if (held) say(world, p.id, 'Your torch gutters out.');
    } else if (p.components.light === undefined) {
      world.update(p.id, { light: TORCH });
    }
  }
  for (const t of world.query('lighting:burn')) {
    if ((heldOf(t.components['lighting:burn'])?.until ?? 0) <= now) world.despawn(t.id);
  }
}

/** Anyone sitting still within a step of a campfire mends. */
function warm(world: WorldAPI): void {
  for (const fire of world.query('lighting:hearth')) {
    if (!world.hasPlayerNear(fire.x, fire.y, 1, fire.world)) continue;
    for (const e of world.queryNear(fire.x, fire.y, 1, fire.world)) {
      if (e.kind === 'player') world.emit('character:heal', { entityId: e.id, amount: 6 });
    }
  }
}

function kindle(world: WorldAPI): void {
  for (const e of world.queryNear(WORLD_CENTER_X, WORLD_CENTER_Y, 25, OVERWORLD)) {
    const glow = FIXTURES[e.kind];
    if (glow && e.components.light === undefined) world.update(e.id, { light: glow });
  }
}

function placeLamps(world: WorldAPI): void {
  if (world.getSet('lighting:lamps-v2') !== undefined) return;
  if (world.tile(WORLD_CENTER_X, WORLD_CENTER_Y, OVERWORLD) !== 'dirt') return;
  world.getSet('lighting:lamps-v2', '1');
  for (const e of world.query('light')) if (e.kind === 'lighting:lamp') world.despawn(e.id);
  for (const [dx, dy] of LAMPS) {
    const x = WORLD_CENTER_X + dx;
    const y = WORLD_CENTER_Y + dy;
    if (world.queryNear(x, y, 0, OVERWORLD).length > 0) continue;
    world.spawn(
      'lighting:lamp',
      { x, y },
      { appearance: { emoji: '🏮', scale: 0.85 }, light: LAMP },
      OVERWORLD,
    );
  }
}

export default definePlugin({
  id: 'lighting',
  entityKinds: ['lighting:planted', 'lighting:lamp', 'lighting:campfire'],
  items: ITEMS,
  recipes: RECIPES,
  persistComponents: ['lighting:held'],

  systems: [
    {
      name: 'lighting:tick',
      fn: (world) => {
        clock++;
        if (clock % 10 === 0) burn(world);
        if (clock % 30 === 0) warm(world);
        if (clock % 50 === 1) placeLamps(world);
        if (clock % 600 === 5) kindle(world);
      },
    },
  ],

  commands: [
    {
      name: 'lighting:use',
      fn: (world, args, id) => use(world, id, (args as { slot?: unknown } | undefined)?.slot),
    },
  ],

  events: {},

  decorateChunk: (world, area, rng) => {
    if (rng() > 0.3) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = area.minX + ((rng() * (area.maxX - area.minX + 1)) | 0);
      const y = area.minY + ((rng() * (area.maxY - area.minY + 1)) | 0);
      const dx = x - WORLD_CENTER_X;
      const dy = y - WORLD_CENTER_Y;
      if (dx * dx + dy * dy < 30 * 30) return;
      const tile = world.tile(x, y);
      if (tile !== 'grass' && tile !== 'dirt' && tile !== 'sand' && tile !== 'snow') continue;
      world.spawn(
        'lighting:campfire',
        { x, y },
        {
          appearance: { emoji: '🔥', scale: 0.95 },
          light: CAMPFIRE,
          label: 'Campfire',
          'lighting:hearth': true,
        },
      );
      return;
    }
  },
});
