import {
  definePlugin,
  OVERWORLD,
  type EntityState,
  type InventoryComponent,
  type ItemDef,
  type RecipeDef,
  type WorldAPI,
} from '@game/shared';

/**
 * Fishing: use a rod near open water to cast, watch the bobber, and use it
 * again the moment a fish bites. What bites depends on the shore (the land
 * around the bobber), your skill, the hour and the sky: eels and squid come
 * out at night, stormfin only rise in a thunderstorm, and now and then the
 * line drags up a boot, a bottle with a note in it, or a sunken chest.
 *
 * `fishing:line` is public so everyone sees your bobber; the skill and the
 * journal of everything you have caught are private and persist. Fish grill
 * at the farm's oven into food that heals.
 *
 * Emits 'fishing:caught' { entityId, item, fish } for every catch.
 */

export interface FishSkill {
  level: number;
  xp: number;
  prev: number;
  next: number;
}

export interface Line {
  /** Bobber tile. */
  x: number;
  y: number;
  /** Where the angler stood; stepping away reels in. */
  sx: number;
  sy: number;
  /** Epoch ms of the next bite, or of when the current bite ends. */
  at: number;
  biting: boolean;
}

export interface Caught {
  icon: string;
  at: number;
  x: number;
  y: number;
}

type Shore = 'meadow' | 'forest' | 'swamp' | 'coast' | 'snow' | 'highlands';

export interface Catch {
  id: string;
  name: string;
  icon: string;
  level: number;
  xp: number;
  value: number;
  weight: number;
  where: string;
  shores?: Shore[];
  world?: string;
  night?: boolean;
  storm?: boolean;
  /** Not a fish: junk and treasure. */
  junk?: boolean;
  description: string;
}

export const CATCHES: Catch[] = [
  { id: 'minnow', name: 'Minnow', icon: '🐟', level: 1, xp: 6, value: 2, weight: 10, where: 'Any water', description: 'Small, silver and very sure of itself.' },
  { id: 'perch', name: 'Perch', icon: '🐠', level: 1, xp: 9, value: 5, weight: 8, where: 'Meadow and forest ponds', shores: ['meadow', 'forest'], description: 'Striped and greedy. Bites at anything.' },
  { id: 'crayfish', name: 'Crayfish', icon: '🦞', level: 3, xp: 11, value: 7, weight: 5, where: 'Muddy banks', shores: ['meadow', 'swamp', 'forest'], description: 'Hangs on to the bait out of spite.' },
  { id: 'trout', name: 'Brook Trout', icon: '🐟', level: 5, xp: 14, value: 10, weight: 6, where: 'Forest and highland water', shores: ['forest', 'highlands'], description: 'Speckled like a thrush and twice as quick.' },
  { id: 'crab', name: 'Shore Crab', icon: '🦀', level: 6, xp: 14, value: 11, weight: 6, where: 'Along the dunes', shores: ['coast'], description: 'Walks sideways out of every argument.' },
  { id: 'moonfish', name: 'Moonfish', icon: '🐠', level: 6, xp: 22, value: 24, weight: 3, where: 'Anywhere, after dark', night: true, description: 'Its scales hold a little of the moon.' },
  { id: 'catfish', name: 'Mud Catfish', icon: '🐡', level: 8, xp: 18, value: 13, weight: 6, where: 'The fens', shores: ['swamp'], description: 'Whiskered, sullen, and heavier than it looks.' },
  { id: 'seabass', name: 'Sea Bass', icon: '🐟', level: 10, xp: 22, value: 16, weight: 5, where: 'Along the dunes', shores: ['coast'], description: 'Fights all the way in.' },
  { id: 'lanternfish', name: 'Lanternfish', icon: '🏮', level: 10, xp: 26, value: 30, weight: 6, where: 'Drowned Reach', world: 'water', description: 'Carries its own light down where there is none.' },
  { id: 'eel', name: 'Fen Eel', icon: '🐍', level: 12, xp: 26, value: 20, weight: 4, where: 'The fens, after dark', shores: ['swamp'], night: true, description: 'Slick as a rumour.' },
  { id: 'stormfin', name: 'Stormfin', icon: '⚡', level: 12, xp: 40, value: 45, weight: 5, where: 'Any water, in a thunderstorm', storm: true, description: 'Only rises when the sky cracks open. It crackles in the hand.' },
  { id: 'icefin', name: 'Icefin', icon: '🧊', level: 14, xp: 30, value: 24, weight: 5, where: 'Snowfield water', shores: ['snow'], description: 'Clear as the water it came from.' },
  { id: 'oyster', name: 'Pearl Oyster', icon: '🦪', level: 15, xp: 34, value: 60, weight: 3, where: 'Drowned Reach', world: 'water', description: 'Something rattles inside. Odo will pay to find out what.' },
  { id: 'squid', name: 'Night Squid', icon: '🦑', level: 16, xp: 34, value: 30, weight: 3, where: 'Along the dunes, after dark', shores: ['coast'], night: true, description: 'Inks the bucket out of pure resentment.' },
  { id: 'pike', name: 'Old Pike', icon: '🐊', level: 18, xp: 40, value: 36, weight: 3, where: 'Forest and highland water', shores: ['forest', 'highlands'], description: 'Has eaten better anglers than you. Or so it looks.' },
  { id: 'golden_carp', name: 'Golden Carp', icon: '🐠', level: 20, xp: 90, value: 150, weight: 0.5, where: 'Anywhere, very rarely', description: 'Said to grant a wish. Odo would rather have the gold.' },
  { id: 'boot', name: 'Old Boot', icon: '👢', level: 1, xp: 2, value: 1, weight: 1.2, where: 'Everywhere, sadly', junk: true, description: 'Someone, somewhere, is walking funny.' },
  { id: 'driftwood', name: 'Driftwood', icon: '🪵', level: 1, xp: 2, value: 2, weight: 1.2, where: 'Everywhere', junk: true, description: 'Dry enough to burn. The sawbench can make torches of it.' },
  { id: 'bottle', name: 'Bottled Note', icon: '🍾', level: 4, xp: 8, value: 4, weight: 0.5, where: 'Everywhere', junk: true, description: 'A corked bottle with a note rolled up inside. Use it to read.' },
  { id: 'chest', name: 'Sunken Chest', icon: '🧰', level: 10, xp: 30, value: 10, weight: 0.25, where: 'Everywhere, rarely', junk: true, description: 'Barnacled shut. Use it to prise the lid.' },
];

const fishId = (c: Catch): string => `fishing:${c.id}`;

const TAGS: Record<string, string[]> = {
  boot: ['loot'],
  driftwood: ['loot', 'wood'],
  bottle: ['loot'],
  chest: ['loot'],
  golden_carp: ['loot', 'trophy'],
  oyster: ['loot'],
};

const HOOK = 'fishing:use';

export const ITEMS: ItemDef[] = [
  { id: 'fishing:rod', name: 'Fishing Rod', tags: ['tool', 'merchandise', 'consumable'], stack: 1, value: 12, use: HOOK, useLabel: 'Cast', icon: '🎣', description: 'Use it near open water to cast. Use it again the moment a fish bites.' },
  ...CATCHES.map(
    (c): ItemDef => ({
      id: fishId(c),
      name: c.name,
      tags: TAGS[c.id] ?? ['fish', 'loot'],
      stack: 20,
      value: c.value,
      icon: c.icon,
      description: c.description,
      ...(c.id === 'bottle' || c.id === 'chest' ? { use: HOOK, useLabel: c.id === 'bottle' ? 'Read' : 'Open' } : {}),
    }),
  ),
  { id: 'fishing:grilled_fish', name: 'Grilled Fish', tags: ['food', 'consumable'], stack: 10, value: 12, use: HOOK, useLabel: 'Eat', icon: '🍢', description: 'Charred at the edges, perfect in the middle. Restores 45 health.' },
  { id: 'fishing:fish_stew', name: 'Fisher’s Stew', tags: ['food', 'consumable'], stack: 10, value: 40, use: HOOK, useLabel: 'Eat', icon: '🍲', description: 'Two fish and a handful of herbs. Restores 120 health.' },
];

const FOOD: Record<string, [number, string]> = {
  'fishing:grilled_fish': [45, 'You eat the grilled fish. Warmth spreads through you.'],
  'fishing:fish_stew': [120, 'The stew is thick and herby. You feel much better.'],
};

const RECIPES: RecipeDef[] = [
  { id: 'fishing:rod', station: 'professions:sawbench', inputs: [{ tag: 'wood', count: 2 }], outputs: [{ id: 'fishing:rod', count: 1 }], ticks: 30 },
  { id: 'fishing:grilled_fish', station: 'farming:oven', inputs: [{ tag: 'fish', count: 1 }], outputs: [{ id: 'fishing:grilled_fish', count: 1 }], ticks: 20 },
  {
    id: 'fishing:fish_stew',
    station: 'farming:oven',
    inputs: [
      { tag: 'fish', count: 2 },
      { tag: 'herb', count: 1 },
    ],
    outputs: [{ id: 'fishing:fish_stew', count: 1 }],
    ticks: 40,
  },
];

const NOTES = [
  'Whoever finds this: the big pike under the old bridge owes me a lure.',
  'Day nine adrift. The gulls have started to recognise me.',
  'If found, please return to Lanternfall. No reward. I just want it back.',
  'The moonfish only bite after dark. Everyone knows that. Everyone who reads notes in bottles, anyway.',
  'Stormfin rise when the sky cracks. Bring a rod, and maybe a better hat.',
  'Roses are red, the fens are a bog, I married a frog. It was mostly fine.',
  'Note to self: the forge can set stormglass. Note to self: what is stormglass?',
  'There is treasure buried under— the rest has been eaten by a crab.',
  'To Claudius, if you ever find this: the best fishing is wherever you are not supposed to be.',
  'Gone fishing. Back never.',
];

const MAX_LEVEL = 30;
const BITE_WINDOW_MS = 2000;

let clock = 0;
let night = false;

function skillAt(xp: number): FishSkill {
  let level = 1;
  while (level < MAX_LEVEL && xp >= 30 * level * level) level++;
  return { level, xp, prev: level === 1 ? 0 : 30 * (level - 1) * (level - 1), next: 30 * level * level };
}

function skillOf(e: EntityState | undefined): FishSkill {
  const s = e?.components['fishing:skill'] as FishSkill | undefined;
  return s && typeof s.xp === 'number' ? s : skillAt(0);
}

function lineOf(e: EntityState | undefined): Line | undefined {
  const l = e?.components['fishing:line'] as Line | undefined;
  return l && typeof l.x === 'number' ? l : undefined;
}

function say(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

const SHORE: Record<string, Shore> = {
  grass: 'meadow',
  dirt: 'meadow',
  forest: 'forest',
  swamp: 'swamp',
  sand: 'coast',
  snow: 'snow',
  mountain: 'highlands',
};

/** The land that rings the bobber decides what lives there. */
function shoreAt(world: WorldAPI, x: number, y: number, place: string): Shore {
  const votes: Partial<Record<Shore, number>> = {};
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const s = SHORE[world.tile(x + dx, y + dy, place)];
      if (s) votes[s] = (votes[s] ?? 0) + 1;
    }
  }
  let best: Shore = 'meadow';
  let most = 0;
  for (const [s, n] of Object.entries(votes) as [Shore, number][]) {
    if (n > most) {
      best = s;
      most = n;
    }
  }
  return best;
}

/** Open water within reach of the rod, preferring a proper cast over a dip at your feet. */
function waterNear(world: WorldAPI, x: number, y: number, place: string): { x: number; y: number } | undefined {
  let best: { x: number; y: number } | undefined;
  let bestScore = -1;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      if (world.tile(x + dx, y + dy, place) !== 'water') continue;
      const d = (dx < 0 ? -dx : dx) > (dy < 0 ? -dy : dy) ? (dx < 0 ? -dx : dx) : dy < 0 ? -dy : dy;
      const score = (d >= 2 && d <= 3 ? 10 : 4 - d / 2) + world.rng();
      if (score > bestScore) {
        bestScore = score;
        best = { x: x + dx, y: y + dy };
      }
    }
  }
  return best;
}

const biteIn = (world: WorldAPI, level: number): number => Date.now() + 2500 + world.rng() * 6000 - level * 60;

function cast(world: WorldAPI, me: EntityState): void {
  const place = me.world ?? OVERWORLD;
  const spot = waterNear(world, me.x, me.y, place);
  if (!spot) {
    say(world, me.id, 'There is no open water within reach of your rod.', 'bad');
    return;
  }
  const line: Line = { x: spot.x, y: spot.y, sx: me.x, sy: me.y, at: biteIn(world, skillOf(me).level), biting: false };
  world.update(me.id, { 'fishing:line': line });
}

function roll(world: WorldAPI, me: EntityState, line: Line): Catch {
  const place = me.world ?? OVERWORLD;
  const shore = shoreAt(world, line.x, line.y, place);
  const level = skillOf(me).level;
  const sky = (me.components['weather:here'] as { sky?: string } | undefined)?.sky;
  const pool = CATCHES.filter(
    (c) =>
      c.level <= level &&
      (!c.shores || c.shores.includes(shore)) &&
      (!c.world || c.world === place) &&
      (!c.night || night) &&
      (!c.storm || sky === 'storm'),
  );
  const total = pool.reduce((sum, c) => sum + c.weight, 0);
  let r = world.rng() * total;
  for (const c of pool) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return CATCHES[0];
}

function reel(world: WorldAPI, me: EntityState, line: Line): void {
  const got = roll(world, me, line);
  const item = fishId(got);
  const left = world.give(me.id, item, 1);
  world.update(me.id, { 'fishing:line': undefined });
  if (left > 0) {
    say(world, me.id, `A ${got.name.toLowerCase()} flops off the hook. Your pack is full.`, 'bad');
    return;
  }
  const skill = skillOf(me);
  const after = skillAt(skill.xp + got.xp);
  const journal = { ...((me.components['fishing:journal'] as Record<string, number> | undefined) ?? {}) };
  const first = !journal[got.id];
  journal[got.id] = (journal[got.id] ?? 0) + 1;
  world.update(me.id, {
    'fishing:skill': after,
    'fishing:journal': journal,
    'fishing:caught': { icon: got.icon, at: Date.now(), x: line.x, y: line.y } satisfies Caught,
  });
  const article = /^[AEIOU]/.test(got.name) ? 'an' : 'a';
  say(world, me.id, `You reel in ${article} ${got.name}!${first && !got.junk ? ' A new entry for your journal.' : ''}`, 'loot');
  if (after.level > skill.level) {
    const unlocked = CATCHES.filter((c) => c.level === after.level && !c.junk).map((c) => c.name);
    say(world, me.id, `Fishing level ${after.level}!${unlocked.length ? ` ${unlocked.join(', ')} will bite for you now.` : ''}`, 'level');
  }
  world.emit('fishing:caught', { entityId: me.id, item, fish: !got.junk });
}

function takeOne(world: WorldAPI, id: number, slot: number, item: string): boolean {
  const inv = world.get(id)?.components.inventory as InventoryComponent | undefined;
  if (!inv || !Array.isArray(inv.slots) || inv.slots[slot]?.itemId !== item) return false;
  const slots = inv.slots.map((s) => ({ ...s }));
  slots[slot].count -= 1;
  if (slots[slot].count <= 0) slots[slot] = { itemId: '', count: 0 };
  world.update(id, { inventory: { ...inv, slots } });
  return true;
}

function use(world: WorldAPI, id: number, slot: unknown): void {
  const me = world.get(id);
  const inv = me?.components.inventory as InventoryComponent | undefined;
  if (!me || typeof slot !== 'number') return;
  const item = inv?.slots?.[slot]?.itemId;
  if (item === 'fishing:rod') {
    const line = lineOf(me);
    if (!line) cast(world, me);
    else if (line.biting) reel(world, me, line);
    else {
      world.update(id, { 'fishing:line': undefined });
      say(world, id, 'You reel in. Nothing on the hook yet.');
    }
    return;
  }
  const food = item ? FOOD[item] : undefined;
  if (item && food && takeOne(world, id, slot, item)) {
    world.emit('character:heal', { entityId: id, amount: food[0] });
    say(world, id, food[1]);
    return;
  }
  if (item === 'fishing:bottle' && takeOne(world, id, slot, item)) {
    const note = NOTES[(world.rng() * NOTES.length) | 0];
    say(world, id, `The note reads: “${note}”`);
    if (world.rng() < 0.5) world.emit('character:grant', { entityId: id, gold: 5 + ((world.rng() * 20) | 0), reason: 'A few coins were rolled up inside.' });
    return;
  }
  if (item === 'fishing:chest' && takeOne(world, id, slot, item)) {
    const gold = 40 + ((world.rng() * 90) | 0);
    world.emit('character:grant', { entityId: id, gold, xp: 20, reason: 'The lid gives with a crack. Old coins spill out!' });
  }
}

function watch(world: WorldAPI): void {
  const now = Date.now();
  for (const p of world.query('fishing:line')) {
    const line = lineOf(p);
    if (!line) continue;
    if (p.x !== line.sx || p.y !== line.sy || p.components.player === undefined) {
      world.update(p.id, { 'fishing:line': undefined });
      continue;
    }
    if (now < line.at) continue;
    if (!line.biting) {
      world.update(p.id, { 'fishing:line': { ...line, biting: true, at: now + BITE_WINDOW_MS } satisfies Line });
    } else {
      world.update(p.id, { 'fishing:line': { ...line, biting: false, at: biteIn(world, skillOf(p).level) } satisfies Line });
      say(world, p.id, 'It got away! The bobber settles again.');
    }
  }
}

export default definePlugin({
  id: 'fishing',
  items: ITEMS,
  recipes: RECIPES,
  entityKinds: [],
  persistComponents: ['fishing:skill', 'fishing:journal'],
  privateComponents: ['fishing:skill', 'fishing:journal'],

  systems: [
    {
      name: 'fishing:tick',
      fn: (world) => {
        clock++;
        if (clock % 2 === 0) watch(world);
      },
    },
  ],

  commands: [
    {
      name: HOOK,
      fn: (world, args, id) => use(world, id, (args as { slot?: unknown } | undefined)?.slot),
    },
  ],

  events: {
    'daynight:hour': (_world, payload) => {
      const h = (payload as { hour?: unknown }).hour;
      if (typeof h === 'number') night = h >= 20 || h < 5;
    },
  },
});
