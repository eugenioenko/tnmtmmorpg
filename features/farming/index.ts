import {
  definePlugin,
  isStatsComponent,
  OVERWORLD,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  type EntityState,
  type InventoryComponent,
  type ItemDef,
  type RecipeDef,
  type WorldAPI,
} from '@game/shared';

/**
 * Farming. Till the ground you stand on with a hoe, plant seeds in the
 * plot, water it to hurry it along, and harvest it when it ripens: wheat,
 * carrots and pumpkins, with seeds to plant again. The bread oven by the
 * farmhouse bakes the harvest into loaves, stew and pie that heal.
 *
 * Tilling turns the ground to dirt (grass returns when the plot goes
 * fallow). A plot is a `farming:plot` entity carrying its owner's name;
 * growth is measured in wall-clock time from planting, so fields keep
 * growing while their owner is away or the server restarts, and it slows at
 * night when the daynight feature says so. Only the owner (or their party)
 * may harvest, until a ripe crop has been left standing for ABANDON_MS.
 *
 * The original 'farming:seed' stays as it was: a 'herb'-tagged item that
 * other features' recipes consume by tag, the Phase 6 interop test.
 */

type CropId = 'wheat' | 'carrot' | 'pumpkin';

interface Crop {
  name: string;
  /** Wall-clock growth per stage; three stages from seed to ripe. */
  stageMs: number;
  ripe: string;
  yield: [number, number];
  seedsBack: [number, number];
  xp: number;
}

const CROPS: Record<CropId, Crop> = {
  wheat: { name: 'Wheat', stageMs: 60_000, ripe: '🌾', yield: [3, 4], seedsBack: [1, 2], xp: 6 },
  carrot: { name: 'Carrots', stageMs: 90_000, ripe: '🥕', yield: [2, 3], seedsBack: [1, 2], xp: 9 },
  pumpkin: { name: 'Pumpkin', stageMs: 150_000, ripe: '🎃', yield: [1, 2], seedsBack: [1, 1], xp: 20 },
};

export interface PlotComponent {
  owner: string;
  tilled: number;
  /** The tile before tilling, restored when the plot goes fallow. */
  was?: string;
  crop?: CropId;
  planted?: number;
  /** Growth credited by watering and lost at night, in ms. */
  bonus?: number;
  stage?: number;
  watered?: boolean;
  ripeAt?: number;
}

const HEALS: Record<string, number> = {
  'farming:loaf': 50,
  'farming:stew': 90,
  'farming:pie': 200,
};

export const ITEMS: ItemDef[] = [
  { id: 'farming:seed', name: 'Seed Bundle', tags: ['herb', 'seed'], stack: 50 },
  { id: 'farming:hoe', name: 'Hoe', tags: ['tool', 'consumable', 'merchandise'], stack: 1, value: 20, use: 'farming:till', useLabel: 'Till', icon: '🪏', description: 'Till the grass or dirt you stand on into a plot. Never wears out.' },
  { id: 'farming:can', name: 'Watering Can', tags: ['tool', 'consumable', 'merchandise'], stack: 1, value: 15, use: 'farming:water', useLabel: 'Water', icon: '💧', description: 'Water every growing crop around you. Watered crops grow faster.' },
  { id: 'farming:wheat_seed', name: 'Wheat Seeds', tags: ['seed', 'food', 'consumable', 'merchandise'], stack: 50, value: 2, use: 'farming:plant', useLabel: 'Plant', icon: '🌾', description: 'Plant in a tilled plot. Ripens in about 3 minutes.' },
  { id: 'farming:carrot_seed', name: 'Carrot Seeds', tags: ['seed', 'food', 'consumable', 'merchandise'], stack: 50, value: 3, use: 'farming:plant', useLabel: 'Plant', icon: '🥕', description: 'Plant in a tilled plot. Ripens in about 4½ minutes.' },
  { id: 'farming:pumpkin_seed', name: 'Pumpkin Seeds', tags: ['seed', 'food', 'consumable', 'merchandise'], stack: 50, value: 6, use: 'farming:plant', useLabel: 'Plant', icon: '🎃', description: 'Plant in a tilled plot. Ripens in about 7½ minutes, and worth it.' },
  { id: 'farming:wheat', name: 'Wheat Sheaf', tags: ['produce', 'grain'], stack: 50, value: 3, icon: '🌾', description: 'Bake it into bread at the oven, or sell it.' },
  { id: 'farming:carrot', name: 'Carrot', tags: ['produce', 'vegetable'], stack: 50, value: 4, icon: '🥕', description: 'Crunchy. Better in a stew.' },
  { id: 'farming:pumpkin', name: 'Pumpkin', tags: ['produce', 'vegetable'], stack: 20, value: 14, icon: '🎃', description: 'Heavy, orange, and destined for pie.' },
  { id: 'farming:loaf', name: 'Farmhouse Loaf', tags: ['food', 'consumable'], stack: 20, value: 8, use: 'farming:eat', useLabel: 'Eat', icon: '🍞', description: 'Still warm. Restores 50 health.' },
  { id: 'farming:stew', name: 'Carrot Stew', tags: ['food', 'consumable'], stack: 10, value: 16, use: 'farming:eat', useLabel: 'Eat', icon: '🍲', description: 'Thick and peppery. Restores 90 health.' },
  { id: 'farming:pie', name: 'Pumpkin Pie', tags: ['food', 'consumable'], stack: 10, value: 40, use: 'farming:eat', useLabel: 'Eat', icon: '🥧', description: 'A whole pie. Restores 200 health.' },
];

const OVEN = 'farming:oven';

const RECIPES: RecipeDef[] = [
  { id: 'farming:loaf', station: OVEN, inputs: [{ id: 'farming:wheat', count: 3 }], outputs: [{ id: 'farming:loaf', count: 2 }], ticks: 30 },
  { id: 'farming:stew', station: OVEN, inputs: [{ id: 'farming:carrot', count: 2 }, { id: 'farming:wheat', count: 1 }], outputs: [{ id: 'farming:stew', count: 1 }], ticks: 40 },
  { id: 'farming:pie', station: OVEN, inputs: [{ id: 'farming:pumpkin', count: 1 }, { id: 'farming:wheat', count: 2 }], outputs: [{ id: 'farming:pie', count: 1 }], ticks: 60 },
];

const SEED_CROP: Record<string, CropId> = {
  'farming:wheat_seed': 'wheat',
  'farming:carrot_seed': 'carrot',
  'farming:pumpkin_seed': 'pumpkin',
};

const MAX_PLOTS = 24;
const FALLOW_MS = 20 * 60_000;
const ABANDON_MS = 20 * 60_000;
const WATER_SHARE = 0.4;
const NIGHT_SLOWDOWN = 0.5;

let clock = 0;
let night = false;

const floor = (n: number): number => n | 0;
const abs = (n: number): number => (n < 0 ? -n : n);

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function plotOf(e: EntityState | undefined): PlotComponent | undefined {
  const p = e?.components['farming:plot'] as PlotComponent | undefined;
  return p && typeof p.owner === 'string' ? p : undefined;
}

function nameOf(e: EntityState | undefined): string | undefined {
  const c = e?.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : undefined;
}

function partyOf(e: EntityState | undefined): number | undefined {
  const t = e?.components['party:tag'] as { id?: unknown } | undefined;
  return typeof t?.id === 'number' ? t.id : undefined;
}

function say(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

function take(world: WorldAPI, id: number, slot: number): string | undefined {
  const e = world.get(id);
  const inv = e?.components.inventory;
  if (!isInventory(inv)) return undefined;
  const cell = inv.slots[slot];
  if (!cell || cell.count <= 0) return undefined;
  const slots = inv.slots.map((s) => ({ ...s }));
  slots[slot].count -= 1;
  if (slots[slot].count <= 0) slots[slot] = { itemId: '', count: 0 };
  world.update(id, { inventory: { ...inv, slots } });
  return cell.itemId;
}

function slotItem(e: EntityState, slot: unknown): string | undefined {
  const inv = e.components.inventory;
  if (!isInventory(inv) || typeof slot !== 'number' || !Number.isInteger(slot)) return undefined;
  const cell = inv.slots[slot];
  return cell && cell.count > 0 ? cell.itemId : undefined;
}

function plotAt(world: WorldAPI, x: number, y: number): EntityState | undefined {
  return world.queryNear(x, y, 0, OVERWORLD).find((e) => e.kind === 'farming:plot' && e.x === x && e.y === y);
}

function look(plot: PlotComponent): { appearance: unknown; name: string } {
  const owner = `${plot.owner}’s`;
  if (!plot.crop) return { appearance: { emoji: '🟫', scale: 0.7 }, name: `${owner} plot` };
  const crop = CROPS[plot.crop];
  const stage = plot.stage ?? 0;
  if (stage >= 3) return { appearance: { emoji: crop.ripe, scale: 1.15 }, name: `${owner} ${crop.name.toLowerCase()} (ripe)` };
  const sizes = [0.75, 0.95, 1.05];
  return {
    appearance: { emoji: stage >= 2 ? '🌿' : '🌱', scale: sizes[stage] },
    name: `${owner} ${crop.name.toLowerCase()} (${stage === 0 ? 'seedling' : 'growing'})`,
  };
}

function write(world: WorldAPI, id: number, plot: PlotComponent): void {
  world.update(id, { 'farming:plot': plot, ...look(plot) });
}

function growth(plot: PlotComponent, now: number): number {
  return now - (plot.planted ?? now) + (plot.bonus ?? 0);
}

function remaining(plot: PlotComponent, now: number): number {
  if (!plot.crop) return 0;
  const left = CROPS[plot.crop].stageMs * 3 - growth(plot, now);
  return left > 0 ? left : 0;
}

function duration(ms: number): string {
  const s = floor(ms / 1000);
  return s >= 60 ? `${floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function till(world: WorldAPI, id: number, slot: unknown): void {
  const me = world.get(id);
  const name = nameOf(me);
  if (!me || !name || slotItem(me, slot) !== 'farming:hoe') return;
  if ((me.world ?? OVERWORLD) !== OVERWORLD) return say(world, id, 'Nothing grows here.', 'bad');
  const ground = world.tile(me.x, me.y, OVERWORLD);
  if (ground !== 'grass' && ground !== 'dirt') return say(world, id, 'Only grass or bare earth can be tilled.', 'bad');
  if (ground === 'dirt' && abs(me.x - WORLD_CENTER_X) <= 14 && abs(me.y - WORLD_CENTER_Y) <= 16) {
    return say(world, id, 'Not on the village roads. Try the grass.', 'bad');
  }
  if (plotAt(world, me.x, me.y)) return say(world, id, 'This ground is already tilled.', 'bad');
  const mine = world.query('farming:plot').filter((e) => plotOf(e)?.owner === name).length;
  if (mine >= MAX_PLOTS) return say(world, id, `You already tend ${MAX_PLOTS} plots. Harvest or let some go fallow.`, 'bad');
  const plot: PlotComponent = { owner: name, tilled: Date.now(), was: ground };
  if (ground !== 'dirt') world.setTile(me.x, me.y, 'dirt', OVERWORLD);
  world.spawn('farming:plot', { x: me.x, y: me.y }, { 'farming:plot': plot, ...look(plot) }, OVERWORLD);
  say(world, id, 'You till the soil. Plant seeds in it.');
}

function plant(world: WorldAPI, id: number, slot: unknown): void {
  const me = world.get(id);
  const name = nameOf(me);
  const seed = me ? slotItem(me, slot) : undefined;
  const cropId = seed ? SEED_CROP[seed] : undefined;
  if (!me || !name || !cropId || typeof slot !== 'number') return;
  const candidates = world
    .queryNear(me.x, me.y, 1, me.world ?? OVERWORLD)
    .filter((e) => e.kind === 'farming:plot' && plotOf(e)?.owner === name && !plotOf(e)?.crop)
    .sort((a, b) => abs(a.x - me.x) + abs(a.y - me.y) - (abs(b.x - me.x) + abs(b.y - me.y)));
  const target = candidates[0];
  const plot = plotOf(target);
  if (!target || !plot) return say(world, id, 'Stand on or beside one of your empty plots to plant. A hoe tills new ones.', 'bad');
  if (!take(world, id, slot)) return;
  write(world, target.id, { ...plot, crop: cropId, planted: Date.now(), bonus: 0, stage: 0, watered: false });
  say(world, id, `You plant ${CROPS[cropId].name.toLowerCase()}. Ripe in about ${duration(CROPS[cropId].stageMs * 3)}.`);
}

function water(world: WorldAPI, id: number, slot: unknown): void {
  const me = world.get(id);
  if (!me || slotItem(me, slot) !== 'farming:can') return;
  let n = 0;
  for (const e of world.queryNear(me.x, me.y, 1, me.world ?? OVERWORLD)) {
    const plot = plotOf(e);
    if (e.kind !== 'farming:plot' || !plot?.crop || (plot.stage ?? 0) >= 3 || plot.watered) continue;
    write(world, e.id, { ...plot, watered: true, bonus: (plot.bonus ?? 0) + CROPS[plot.crop].stageMs * WATER_SHARE });
    n++;
  }
  say(world, id, n > 0 ? `You water ${n} plant${n > 1 ? 's' : ''}. They perk up.` : 'Nothing around you needs water right now.');
}

function harvest(world: WorldAPI, id: number, target: EntityState): void {
  const me = world.get(id);
  const plot = plotOf(target);
  const name = nameOf(me);
  if (!me || !plot || !name || !plot.crop) return;
  const crop = CROPS[plot.crop];
  const now = Date.now();
  const mine = plot.owner === name;
  const owner = world.query('player').find((p) => nameOf(p) === plot.owner);
  const party = partyOf(me) !== undefined && partyOf(me) === partyOf(owner);
  const abandoned = plot.ripeAt !== undefined && now - plot.ripeAt > ABANDON_MS;
  if (!mine && !party && !abandoned) return say(world, id, `These are ${plot.owner}’s ${crop.name.toLowerCase()}.`, 'bad');

  const roll = (r: [number, number]): number => r[0] + floor(world.rng() * (r[1] - r[0] + 1));
  const got = roll(crop.yield);
  const seeds = roll(crop.seedsBack);
  const seedId = Object.keys(SEED_CROP).find((k) => SEED_CROP[k] === plot.crop) as string;
  for (const [item, count] of [[`farming:${plot.crop}`, got], [seedId, seeds]] as [string, number][]) {
    const left = world.give(id, item, count);
    if (left > 0) world.spawn('item', { x: me.x, y: me.y }, { itemDrop: { itemId: item, count: left } }, me.world);
  }
  world.emit('character:grant', {
    entityId: id,
    xp: crop.xp,
    reason: `Harvested ${got} ${crop.name.toLowerCase()} and ${seeds} seed${seeds > 1 ? 's' : ''} · +${crop.xp} XP`,
    tone: 'loot',
  });
  const fresh: PlotComponent = { owner: plot.owner, tilled: now, was: plot.was };
  write(world, target.id, fresh);
}

function tend(world: WorldAPI, id: number, targetId: unknown): void {
  const me = world.get(id);
  const target = typeof targetId === 'number' ? world.get(targetId) : undefined;
  const plot = plotOf(target);
  if (!me || !target || !plot || abs(me.x - target.x) > 1 || abs(me.y - target.y) > 1) return;
  if (!plot.crop) {
    const inv = me.components.inventory;
    const slot = isInventory(inv) ? inv.slots.findIndex((s) => s.count > 0 && SEED_CROP[s.itemId] !== undefined) : -1;
    if (slot >= 0 && plot.owner === nameOf(me)) return plant(world, id, slot);
    return say(world, id, plot.owner === nameOf(me) ? 'An empty plot. Buy seeds from Morwen and plant them here.' : `${plot.owner}’s empty plot.`);
  }
  if ((plot.stage ?? 0) >= 3) return harvest(world, id, target);
  const crop = CROPS[plot.crop];
  const hint = plot.watered ? '' : ' Water it to hurry it along.';
  say(world, id, `${crop.name}: ripe in about ${duration(remaining(plot, Date.now()))}.${hint}`);
}

function eat(world: WorldAPI, id: number, slot: unknown): void {
  const me = world.get(id);
  const item = me ? slotItem(me, slot) : undefined;
  const heal = item ? HEALS[item] : undefined;
  if (!me || heal === undefined || typeof slot !== 'number') return;
  const s = me.components.stats;
  if (isStatsComponent(s) && s.hp >= s.maxHp) return say(world, id, 'You are already at full health.');
  if (!take(world, id, slot)) return;
  world.emit('character:heal', { entityId: id, amount: heal });
}

function grow(world: WorldAPI): void {
  const now = Date.now();
  for (const e of world.query('farming:plot')) {
    const plot = plotOf(e);
    if (!plot) continue;
    if (!plot.crop) {
      if (now - plot.tilled > FALLOW_MS) {
        if (plot.was && plot.was !== 'dirt' && world.tile(e.x, e.y, OVERWORLD) === 'dirt') world.setTile(e.x, e.y, plot.was, OVERWORLD);
        world.despawn(e.id);
      }
      continue;
    }
    const was = plot.stage ?? 0;
    if (was >= 3) continue;
    let bonus = plot.bonus ?? 0;
    if (night) bonus -= 2000 * NIGHT_SLOWDOWN;
    const next = { ...plot, bonus };
    const stageNow = floor(growth(next, now) / CROPS[plot.crop].stageMs);
    const stage = stageNow > 3 ? 3 : stageNow;
    if (stage !== was) {
      write(world, e.id, { ...next, stage, watered: false, ripeAt: stage >= 3 ? now : undefined });
    } else if (night) {
      world.update(e.id, { 'farming:plot': next });
    }
  }
}

function settle(world: WorldAPI): void {
  const x0 = WORLD_CENTER_X + 10;
  const y0 = WORLD_CENTER_Y + 9;
  for (let r = 0; r < 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (!world.walkable(x, y, OVERWORLD) || world.queryNear(x, y, 1, OVERWORLD).length > 0) continue;
        world.spawn(OVEN, { x, y }, { label: 'Bread Oven', appearance: { emoji: '♨️', scale: 1.2 } }, OVERWORLD);
        world.log('bread oven built by the farmhouse');
        return;
      }
    }
  }
}

export default definePlugin({
  id: 'farming',
  items: ITEMS,
  recipes: RECIPES,
  entityKinds: ['farming:plot', OVEN],

  systems: [
    {
      name: 'farming:tick',
      fn: (world) => {
        clock++;
        if ((clock === 40 || clock % 600 === 0) && world.tile(WORLD_CENTER_X, WORLD_CENTER_Y, OVERWORLD) === 'dirt') {
          if (world.getSet('farming:oven-v1') === undefined) {
            world.getSet('farming:oven-v1', '1');
            settle(world);
          }
        }
        if (clock % 20 === 0) grow(world);
      },
    },
  ],

  commands: [
    {
      // Test helper: hand the sender a handful of seeds.
      name: 'farming:give',
      fn: (world, _args, entityId) => {
        const count = 4;
        const leftover = world.give(entityId, 'farming:seed', count);
        world.log(
          `gave ${count - leftover}/${count} 'farming:seed' to entity ${entityId}` +
            (leftover > 0 ? ` (${leftover} did not fit)` : ''),
        );
      },
    },
    { name: 'farming:till', fn: (world, args, id) => till(world, id, (args as { slot?: unknown } | undefined)?.slot) },
    { name: 'farming:plant', fn: (world, args, id) => plant(world, id, (args as { slot?: unknown } | undefined)?.slot) },
    { name: 'farming:water', fn: (world, args, id) => water(world, id, (args as { slot?: unknown } | undefined)?.slot) },
    { name: 'farming:eat', fn: (world, args, id) => eat(world, id, (args as { slot?: unknown } | undefined)?.slot) },
    { name: 'farming:tend', fn: (world, args, id) => tend(world, id, (args as { targetId?: unknown } | undefined)?.targetId) },
    { name: 'farming:bake', fn: () => undefined },
  ],

  events: {
    'daynight:hour': (_world, payload) => {
      const h = (payload as { hour?: unknown }).hour;
      if (typeof h === 'number') night = h >= 21 || h < 5;
    },
  },
});
