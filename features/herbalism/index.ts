import {
  definePlugin,
  OVERWORLD,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  type EntityState,
  type InventoryComponent,
  type ItemDef,
  type LightComponent,
  type RecipeDef,
  type WorldAPI,
} from '@game/shared';

/**
 * Herbalism: wild herbs to pick, a skill that grows with every handful, and
 * a cauldron beside the Alchemist's house that brews them into potions.
 *
 * Each biome has its own herb, and the rarer ones need a higher level. Some
 * glow faintly, which only shows after dark. Moonpetal only opens at night.
 * A picked herb leaves a sprout that grows back in a few minutes; the
 * regrowth time is wall-clock, so a restart does not lose it.
 *
 * Potions brewed here include the character feature's healing draughts (by
 * item id), a Night Eye draught that lets you see in the dark (core `light`),
 * and a Mana Tonic (the classes feature's 'classes:restore' event).
 */

export interface Herb {
  id: string;
  name: string;
  icon: string;
  where: string;
  tiles: string[];
  level: number;
  xp: number;
  chance: number;
  light?: LightComponent;
  /** Only opens between dusk and dawn. */
  night?: boolean;
  /** Only this far (Chebyshev tiles) or more from the village. */
  far?: number;
}

export const HERBS: Herb[] = [
  {
    id: 'meadowsweet',
    name: 'Meadowsweet',
    icon: '🌼',
    where: 'Meadows',
    tiles: ['grass'],
    level: 1,
    xp: 8,
    chance: 0.0035,
  },
  {
    id: 'mossroot',
    name: 'Mossroot',
    icon: '🌿',
    where: 'Forests',
    tiles: ['forest'],
    level: 4,
    xp: 12,
    chance: 0.006,
  },
  {
    id: 'sunpetal',
    name: 'Sunpetal',
    icon: '🌻',
    where: 'Beaches and dunes',
    tiles: ['sand'],
    level: 8,
    xp: 16,
    chance: 0.005,
  },
  {
    id: 'bogmyrtle',
    name: 'Bog Myrtle',
    icon: '🪷',
    where: 'Swamps',
    tiles: ['swamp'],
    level: 12,
    xp: 20,
    chance: 0.006,
  },
  {
    id: 'frostbloom',
    name: 'Frostbloom',
    icon: '🪻',
    where: 'Snowfields',
    tiles: ['snow'],
    level: 16,
    xp: 26,
    chance: 0.005,
    light: { radius: 1.6, color: 0x9fd0ff, intensity: 0.5 },
  },
  {
    id: 'glowcap',
    name: 'Glowcap',
    icon: '🍄',
    where: 'Deep forest, far from the village',
    tiles: ['forest'],
    level: 20,
    xp: 34,
    chance: 0.002,
    far: 150,
    light: { radius: 2, color: 0x8dffb0, intensity: 0.6, flicker: 0.1 },
  },
  {
    id: 'moonpetal',
    name: 'Moonpetal',
    icon: '💮',
    where: 'Meadows, open only at night',
    tiles: ['grass'],
    level: 10,
    xp: 22,
    chance: 0.0008,
    night: true,
    light: { radius: 1.8, color: 0xd8c8ff, intensity: 0.55 },
  },
];

const BY_ID = new Map(HERBS.map((h) => [h.id, h]));
const REGROW_MS = 4 * 60_000;
const CAULDRON = 'herbalism:cauldron';
const MAX_LEVEL = 30;

export interface HerbComponent {
  herb: string;
  /** Epoch ms when a picked herb is back; absent while ready. */
  regrows?: number;
}

export interface HerbSkill {
  level: number;
  xp: number;
  prev: number;
  next: number;
}

const itemId = (herb: Herb): string => `herbalism:${herb.id}`;

export const ITEMS: ItemDef[] = [
  ...HERBS.map((h): ItemDef => ({
    id: itemId(h),
    name: h.name,
    tags: ['herb', 'material'],
    stack: 30,
    value: 2 + h.level,
    icon: h.icon,
    description: `${h.where}. Brew it at the cauldron by the Alchemist’s house.`,
  })),
  {
    id: 'herbalism:night_eye',
    name: 'Night Eye Draught',
    tags: ['consumable', 'potion'],
    stack: 10,
    value: 30,
    use: 'herbalism:drink',
    useLabel: 'Drink',
    icon: '🫙',
    description: 'Moonpetal and meadowsweet. For four minutes the dark gives way around you.',
  },
  {
    id: 'herbalism:mana_tonic',
    name: 'Mana Tonic',
    tags: ['consumable', 'potion'],
    stack: 10,
    value: 28,
    use: 'herbalism:drink',
    useLabel: 'Drink',
    icon: '🧉',
    description: 'Sunpetal steeped over frostbloom. Restores 60 mana.',
  },
];

const brew = (
  id: string,
  inputs: [string, number][],
  out: string,
  count: number,
  ticks: number,
): RecipeDef => ({
  id,
  station: CAULDRON,
  inputs: inputs.map(([herb, n]) => ({ id: `herbalism:${herb}`, count: n })),
  outputs: [{ id: out, count }],
  ticks,
});

const RECIPES: RecipeDef[] = [
  brew('herbalism:brew_minor', [['meadowsweet', 3]], 'character:minor_draught', 2, 30),
  brew(
    'herbalism:brew_draught',
    [
      ['meadowsweet', 2],
      ['mossroot', 2],
    ],
    'character:draught',
    1,
    40,
  ),
  brew(
    'herbalism:brew_greater',
    [
      ['mossroot', 2],
      ['bogmyrtle', 2],
      ['glowcap', 1],
    ],
    'character:greater_draught',
    1,
    60,
  ),
  brew(
    'herbalism:brew_night_eye',
    [
      ['moonpetal', 1],
      ['meadowsweet', 1],
    ],
    'herbalism:night_eye',
    1,
    40,
  ),
  brew(
    'herbalism:brew_mana',
    [
      ['sunpetal', 2],
      ['frostbloom', 1],
    ],
    'herbalism:mana_tonic',
    1,
    40,
  ),
];

function skillAt(xp: number): HerbSkill {
  let level = 1;
  while (level < MAX_LEVEL && xp >= 30 * level * level) level++;
  return {
    level,
    xp,
    prev: level === 1 ? 0 : 30 * (level - 1) * (level - 1),
    next: 30 * level * level,
  };
}

function skillOf(e: EntityState | undefined): HerbSkill {
  const s = e?.components['herbalism:skill'] as HerbSkill | undefined;
  return s && typeof s.xp === 'number' ? s : skillAt(0);
}

function herbOf(e: EntityState | undefined): HerbComponent | undefined {
  const h = e?.components['herbalism:herb'] as HerbComponent | undefined;
  return h && typeof h.herb === 'string' ? h : undefined;
}

function say(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const dx = a.x > b.x ? a.x - b.x : b.x - a.x;
  const dy = a.y > b.y ? a.y - b.y : b.y - a.y;
  return dx > dy ? dx : dy;
};

let night = false;

function look(herb: Herb, ready: boolean): Record<string, unknown> {
  if (!ready)
    return {
      appearance: { emoji: '🌱', scale: 0.6 },
      name: `${herb.name} sprout`,
      light: undefined,
    };
  return { appearance: { emoji: herb.icon, scale: 0.75 }, name: herb.name, light: herb.light };
}

function plant(world: WorldAPI, herb: Herb, x: number, y: number): void {
  world.spawn(
    'herbalism:plant',
    { x, y },
    { 'herbalism:herb': { herb: herb.id } satisfies HerbComponent, ...look(herb, true) },
  );
}

function pick(world: WorldAPI, id: number, targetId: unknown): void {
  const me = world.get(id);
  const target = typeof targetId === 'number' ? world.get(targetId) : undefined;
  const state = herbOf(target);
  const herb = state ? BY_ID.get(state.herb) : undefined;
  if (
    !me ||
    !target ||
    !state ||
    !herb ||
    (me.world ?? OVERWORLD) !== (target.world ?? OVERWORLD) ||
    cheb(me, target) > 1
  )
    return;
  if (state.regrows !== undefined) {
    say(world, id, `Only a sprout is left. The ${herb.name.toLowerCase()} will grow back.`);
    return;
  }
  if (herb.night && !night) {
    say(world, id, 'The moonpetal is shut tight. It opens after dark.');
    return;
  }
  const skill = skillOf(me);
  if (skill.level < herb.level) {
    say(
      world,
      id,
      `You need herbalism level ${herb.level} to gather ${herb.name.toLowerCase()}.`,
      'bad',
    );
    return;
  }
  const count = world.rng() < 0.3 + skill.level * 0.01 ? 2 : 1;
  const left = world.give(id, itemId(herb), count);
  if (left >= count) {
    say(world, id, 'Your pack is full.', 'bad');
    return;
  }
  world.update(target.id, {
    'herbalism:herb': { herb: herb.id, regrows: Date.now() + REGROW_MS } satisfies HerbComponent,
    ...look(herb, false),
  });
  const after = skillAt(skill.xp + herb.xp);
  world.update(id, { 'herbalism:skill': after });
  say(world, id, `You gather ${count - left} ${herb.name}.`, 'loot');
  if (after.level > skill.level) {
    const unlocked = HERBS.filter((h) => h.level === after.level).map((h) => h.name);
    say(
      world,
      id,
      `Herbalism level ${after.level}!${unlocked.length ? ` You can now gather ${unlocked.join(', ')}.` : ''}`,
      'level',
    );
  }
  world.emit('herbalism:gathered', { entityId: id, herb: herb.id, count: count - left });
}

function takeOne(world: WorldAPI, id: number, slot: unknown, item: string): boolean {
  const inv = world.get(id)?.components.inventory as InventoryComponent | undefined;
  if (
    !inv ||
    !Array.isArray(inv.slots) ||
    typeof slot !== 'number' ||
    inv.slots[slot]?.itemId !== item
  )
    return false;
  const slots = inv.slots.map((s) => ({ ...s }));
  slots[slot].count -= 1;
  if (slots[slot].count <= 0) slots[slot] = { itemId: '', count: 0 };
  world.update(id, { inventory: { ...inv, slots } });
  return true;
}

const NIGHT_EYE: LightComponent = { radius: 8, color: 0xa8c4ff, intensity: 0.8 };
const NIGHT_EYE_MS = 4 * 60_000;

function drink(world: WorldAPI, id: number, slot: unknown): void {
  const inv = world.get(id)?.components.inventory as InventoryComponent | undefined;
  const item = typeof slot === 'number' ? inv?.slots?.[slot]?.itemId : undefined;
  if (item === 'herbalism:night_eye' && takeOne(world, id, slot, item)) {
    world.update(id, {
      'herbalism:night_eye': { until: Date.now() + NIGHT_EYE_MS },
      light: NIGHT_EYE,
    });
    say(world, id, 'Your eyes sting, then the dark thins out around you.');
  } else if (item === 'herbalism:mana_tonic' && takeOne(world, id, slot, item)) {
    world.emit('classes:restore', { entityId: id, mana: 60 });
    say(world, id, 'Cool and bitter. Your mana surges back.');
  }
}

let clock = 0;

function regrow(world: WorldAPI): void {
  const now = Date.now();
  for (const e of world.query('herbalism:herb')) {
    const state = herbOf(e);
    const herb = state ? BY_ID.get(state.herb) : undefined;
    if (!state || !herb || state.regrows === undefined || state.regrows > now) continue;
    world.update(e.id, { 'herbalism:herb': { herb: herb.id }, ...look(herb, true) });
  }
  for (const p of world.query('herbalism:night_eye')) {
    const eye = p.components['herbalism:night_eye'] as { until?: number } | undefined;
    if (!eye || (eye.until ?? 0) > now) continue;
    world.update(p.id, { 'herbalism:night_eye': undefined, light: undefined });
    say(world, p.id, 'Your night eyes fade.');
  }
}

/** Herbs that suit a tile, given its distance from the village. */
function herbFor(tile: string, d: number, roll: number): Herb | undefined {
  let acc = 0;
  for (const herb of HERBS) {
    if (!herb.tiles.includes(tile) || (herb.far !== undefined && d < herb.far)) continue;
    acc += herb.chance;
    if (roll < acc) return herb;
  }
  return undefined;
}

/** First run: the ground around the village was explored before herbs existed, so sow it once. */
function sow(world: WorldAPI): void {
  if (world.getSet('herbalism:sown-v1') !== undefined) return;
  if (world.tile(WORLD_CENTER_X, WORLD_CENTER_Y, OVERWORLD) !== 'dirt') return;
  world.getSet('herbalism:sown-v1', '1');
  let n = 0;
  for (let attempt = 0; attempt < 4000 && n < 70; attempt++) {
    const r = 14 + world.rng() * 70;
    const a = world.rng();
    const x = WORLD_CENTER_X + ((r * (2 * a - 1)) | 0);
    const y = WORLD_CENTER_Y + ((r * (world.rng() * 2 - 1)) | 0);
    if (cheb({ x, y }, { x: WORLD_CENTER_X, y: WORLD_CENTER_Y }) < 12) continue;
    const tile = world.tile(x, y, OVERWORLD);
    const herb = HERBS.find(
      (h) => h.tiles.includes(tile) && h.far === undefined && (h.level <= 12 || world.rng() < 0.3),
    );
    if (!herb || !world.walkable(x, y, OVERWORLD) || world.queryNear(x, y, 0, OVERWORLD).length)
      continue;
    plant(world, herb.night && world.rng() > 0.15 ? HERBS[0] : herb, x, y);
    n++;
  }
  world.log(`sowed ${n} herbs around the village`);
}

function settle(world: WorldAPI): void {
  if (world.getSet('herbalism:cauldron-v1') !== undefined) return;
  if (world.tile(WORLD_CENTER_X, WORLD_CENTER_Y, OVERWORLD) !== 'dirt') return;
  const x0 = WORLD_CENTER_X + 10;
  const y0 = WORLD_CENTER_Y - 3;
  for (let r = 0; r < 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (!world.walkable(x, y, OVERWORLD) || world.queryNear(x, y, 1, OVERWORLD).length > 0)
          continue;
        world.spawn(
          CAULDRON,
          { x, y },
          {
            label: 'Cauldron',
            appearance: { emoji: '🫕', scale: 1.15 },
            light: { radius: 2.6, color: 0x7dff9a, flicker: 0.35, intensity: 0.7 },
          },
          OVERWORLD,
        );
        world.getSet('herbalism:cauldron-v1', '1');
        return;
      }
    }
  }
}

export default definePlugin({
  id: 'herbalism',
  items: ITEMS,
  recipes: RECIPES,
  entityKinds: ['herbalism:plant', CAULDRON],
  persistComponents: ['herbalism:skill'],
  privateComponents: ['herbalism:skill'],

  systems: [
    {
      name: 'herbalism:tick',
      fn: (world) => {
        clock++;
        if (clock % 50 === 0) regrow(world);
        if (clock % 100 === 7) {
          settle(world);
          sow(world);
        }
      },
    },
  ],

  commands: [
    {
      name: 'herbalism:pick',
      fn: (world, args, id) =>
        pick(world, id, (args as { targetId?: unknown } | undefined)?.targetId),
    },
    {
      name: 'herbalism:drink',
      fn: (world, args, id) => drink(world, id, (args as { slot?: unknown } | undefined)?.slot),
    },
    { name: 'herbalism:brew', fn: () => undefined },
  ],

  events: {
    'daynight:hour': (_world, payload) => {
      const h = (payload as { hour?: unknown }).hour;
      if (typeof h === 'number') night = h >= 20 || h < 5;
    },
  },

  decorateChunk: (world, area, rng) => {
    for (let y = area.minY; y <= area.maxY; y++) {
      for (let x = area.minX; x <= area.maxX; x++) {
        const roll = rng();
        if (roll > 0.007) continue;
        const d = cheb({ x, y }, { x: WORLD_CENTER_X, y: WORLD_CENTER_Y });
        if (d < 12) continue;
        const herb = herbFor(world.tile(x, y), d, roll);
        if (herb) plant(world, herb, x, y);
      }
    }
  },
});
