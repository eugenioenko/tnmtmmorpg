import {
  definePlugin,
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
 * Market stalls. A player sets one up near the village, stocks it from their
 * pack at prices of their choosing, and walks away: anyone can buy from it
 * while the owner is out hunting or offline. Takings collect in the stall's
 * till until the owner empties it. Packing up returns the stall, the unsold
 * stock and the till. One stall per character.
 *
 * Gold leaves the buyer through 'character:charge' and is answered
 * asynchronously, so the stall is re-read before anything changes hands.
 */

export interface Good {
  itemId: string;
  count: number;
  price: number;
}

export interface Stall {
  owner: string;
  name?: string;
  goods: Good[];
  till: number;
  since: number;
}

export const KIND = 'stalls:stall';
export const ITEM = 'stalls:kit';
export const RANGE = 2;
export const MAX_GOODS = 8;
export const MAX_PRICE = 9999;
export const MAX_NAME = 24;
const MARKET_RADIUS = 40;
const LOOK = { emoji: '⛺', scale: 1.6 };

export const ITEMS: ItemDef[] = [
  {
    id: ITEM,
    name: 'Market Stall',
    tags: ['consumable', 'construction', 'tool', 'merchandise'],
    stack: 1,
    value: 40,
    use: 'stalls:place',
    useLabel: 'Set up',
    icon: '⛺',
    description: 'Set it up within a short walk of the village square, stock it from your pack and sell while you are away.',
  },
];

const RECIPES: RecipeDef[] = [
  {
    id: ITEM,
    station: 'professions:sawbench',
    inputs: [{ tag: 'plank', count: 6 }],
    outputs: [{ id: ITEM, count: 1 }],
    ticks: 30,
  },
];

const abs = (n: number): number => (n < 0 ? -n : n);
const floor = (n: number): number => n | 0;

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function nameOf(e: EntityState | undefined): string | undefined {
  const c = e?.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : undefined;
}

function goldOf(e: EntityState | undefined): number {
  const c = e?.components.character as { gold?: unknown } | undefined;
  return typeof c?.gold === 'number' ? c.gold : 0;
}

function stallOf(e: EntityState | undefined): Stall | undefined {
  const s = e?.components[KIND] as Stall | undefined;
  return s && typeof s.owner === 'string' && Array.isArray(s.goods) ? s : undefined;
}

function say(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? floor(v) : 0;
}

export function labelOf(s: Stall): string {
  return s.name ? s.name : `${s.owner}’s Stall`;
}

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^\p{L}\p{N} '&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

const names = new Map<string, string>();
function itemName(world: WorldAPI, itemId: string, n = 1): string {
  if (!names.has(itemId)) {
    for (const tag of ['loot', 'material', 'produce', 'food', 'potion', 'equipment', 'tool', 'consumable', 'trophy', 'treasure', 'crafted']) {
      for (const def of world.queryItemsByTag(tag)) names.set(def.id, def.name);
    }
  }
  const name = names.get(itemId) ?? itemId.split(':')[1] ?? itemId;
  return n === 1 ? name : `${n} × ${name}`;
}

/** The stall this player is standing at, if any. */
function near(world: WorldAPI, id: number, stallId: unknown): { me: EntityState; e: EntityState; stall: Stall } | undefined {
  const me = world.get(id);
  const e = typeof stallId === 'number' ? world.get(stallId) : undefined;
  const stall = stallOf(e);
  if (!me || !e || !stall) return undefined;
  if ((me.world ?? OVERWORLD) !== (e.world ?? OVERWORLD) || abs(me.x - e.x) > RANGE || abs(me.y - e.y) > RANGE) {
    say(world, id, 'Step up to the stall first.', 'bad');
    return undefined;
  }
  return { me, e, stall };
}

function own(world: WorldAPI, id: number, stallId: unknown): { me: EntityState; e: EntityState; stall: Stall } | undefined {
  const at = near(world, id, stallId);
  if (!at || at.stall.owner !== nameOf(at.me)) return undefined;
  return at;
}

function save(world: WorldAPI, e: EntityState, stall: Stall): void {
  world.update(e.id, { [KIND]: stall, label: labelOf(stall) });
}

function place(world: WorldAPI, id: number, slot: unknown): void {
  const me = world.get(id);
  const name = nameOf(me);
  const inv = me?.components.inventory;
  if (!me || !name || !isInventory(inv) || typeof slot !== 'number' || !Number.isInteger(slot)) return;
  if (inv.slots[slot]?.itemId !== ITEM || inv.slots[slot].count <= 0) return;
  if ((me.world ?? OVERWORLD) !== OVERWORLD || abs(me.x - WORLD_CENTER_X) > MARKET_RADIUS || abs(me.y - WORLD_CENTER_Y) > MARKET_RADIUS) {
    return say(world, id, 'Stalls go up near the village, where the buyers are.', 'bad');
  }
  if (world.query(KIND).some((e) => stallOf(e)?.owner === name)) return say(world, id, 'You already keep a stall. Pack it up before setting up another.', 'bad');
  const spots: [number, number][] = [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const spot = spots.map(([dx, dy]) => ({ x: me.x + dx, y: me.y + dy })).find((p) => world.walkable(p.x, p.y, OVERWORLD) && world.tile(p.x, p.y, OVERWORLD) !== 'bridge' && world.queryNear(p.x, p.y, 1, OVERWORLD).every((o) => o.kind === 'player'));
  if (!spot) return say(world, id, 'There is no room here. Find an open patch of ground.', 'bad');
  const slots = inv.slots.map((s) => ({ ...s }));
  slots[slot] = { itemId: '', count: 0 };
  world.update(id, { inventory: { ...inv, slots } });
  const stall: Stall = { owner: name, goods: [], till: 0, since: Date.now() };
  world.spawn(KIND, spot, { [KIND]: stall, label: labelOf(stall), appearance: LOOK }, OVERWORLD);
  say(world, id, 'Your stall is up. Step up to it to stock goods and set prices.', 'good');
  for (const p of world.query('player')) if (p.id !== id) say(world, p.id, `⛺ ${name} opened a stall in the market.`);
  world.log(`${name} set up a stall at ${spot.x},${spot.y}`);
}

function stock(world: WorldAPI, id: number, a: Record<string, unknown>): void {
  const at = own(world, id, a.stallId);
  const inv = at?.me.components.inventory;
  if (!at || !isInventory(inv)) return;
  const slot = int(a.slot);
  const cell = inv.slots[slot];
  const price = int(a.price);
  if (!cell || cell.count <= 0 || !cell.itemId) return;
  if (price < 1 || price > MAX_PRICE) return say(world, id, `Set a price between 1 and ${MAX_PRICE} gold.`, 'bad');
  const asked = int(a.count);
  const n = asked > 0 && asked < cell.count ? asked : cell.count;
  const goods = at.stall.goods.map((g) => ({ ...g }));
  const same = goods.find((g) => g.itemId === cell.itemId && g.price === price);
  if (!same && goods.length >= MAX_GOODS) return say(world, id, `A stall holds ${MAX_GOODS} kinds of goods.`, 'bad');
  const slots = inv.slots.map((s) => ({ ...s }));
  slots[slot].count -= n;
  if (slots[slot].count <= 0) slots[slot] = { itemId: '', count: 0 };
  world.update(id, { inventory: { ...inv, slots } });
  if (same) same.count += n;
  else goods.push({ itemId: cell.itemId, count: n, price });
  save(world, at.e, { ...at.stall, goods });
}

function unstock(world: WorldAPI, id: number, a: Record<string, unknown>): void {
  const at = own(world, id, a.stallId);
  const g = at?.stall.goods[int(a.index)];
  if (!at || !g) return;
  const left = world.give(id, g.itemId, g.count);
  const goods = at.stall.goods.map((x, i) => (i === int(a.index) ? { ...x, count: left } : x)).filter((x) => x.count > 0);
  save(world, at.e, { ...at.stall, goods });
  if (left > 0) say(world, id, `Your pack is full; ${left} stay on the stall.`, 'bad');
}

function reprice(world: WorldAPI, id: number, a: Record<string, unknown>): void {
  const at = own(world, id, a.stallId);
  const index = int(a.index);
  const price = int(a.price);
  if (!at || !at.stall.goods[index] || price < 1 || price > MAX_PRICE) return;
  save(world, at.e, { ...at.stall, goods: at.stall.goods.map((g, i) => (i === index ? { ...g, price } : g)) });
}

function rename(world: WorldAPI, id: number, a: Record<string, unknown>): void {
  const at = own(world, id, a.stallId);
  if (!at) return;
  const name = cleanName(a.name);
  save(world, at.e, { ...at.stall, name: name || undefined });
}

function collect(world: WorldAPI, id: number, a: Record<string, unknown>): void {
  const at = own(world, id, a.stallId);
  if (!at || at.stall.till <= 0) return;
  world.emit('character:grant', { entityId: id, gold: at.stall.till, reason: `You empty the till: +${at.stall.till} gold.`, tone: 'good' });
  save(world, at.e, { ...at.stall, till: 0 });
}

function packUp(world: WorldAPI, id: number, a: Record<string, unknown>): void {
  const at = own(world, id, a.stallId);
  const inv = at?.me.components.inventory;
  if (!at || !isInventory(inv)) return;
  const free = inv.slots.filter((s) => s.count <= 0 || !s.itemId).length;
  if (free < at.stall.goods.length + 1) return say(world, id, `Make room in your pack first: you need ${at.stall.goods.length + 1} free slots.`, 'bad');
  let spilled = 0;
  for (const g of [...at.stall.goods, { itemId: ITEM, count: 1, price: 0 }]) {
    const left = world.give(id, g.itemId, g.count);
    if (left > 0) {
      spilled += left;
      world.spawn('item', { x: at.me.x, y: at.me.y }, { itemDrop: { itemId: g.itemId, count: left } }, at.me.world);
    }
  }
  if (at.stall.till > 0) world.emit('character:grant', { entityId: id, gold: at.stall.till });
  world.despawn(at.e.id);
  say(world, id, `You pack up your stall${at.stall.till > 0 ? ` and pocket ${at.stall.till} gold` : ''}.${spilled ? ' Some goods did not fit and lie at your feet.' : ''}`, 'good');
}

function buy(world: WorldAPI, id: number, a: Record<string, unknown>): void {
  const at = near(world, id, a.stallId);
  const name = nameOf(at?.me);
  if (!at || !name) return;
  const index = int(a.index);
  const g = at.stall.goods[index];
  if (!g) return;
  if (at.stall.owner === name) return say(world, id, 'That is your own stall.', 'bad');
  const asked = int(a.count);
  const n = asked < 1 ? 1 : asked > g.count ? g.count : asked;
  const cost = n * g.price;
  if (goldOf(at.me) < cost) return say(world, id, `That costs ${cost} gold; you carry ${goldOf(at.me)}.`, 'bad');
  const stallId = at.e.id;
  world.emit('character:charge', {
    entityId: id,
    gold: cost,
    then: (w: WorldAPI, ok: boolean) => {
      if (!ok) return say(w, id, 'Not enough gold.', 'bad');
      const e = w.get(stallId);
      const stall = stallOf(e);
      const now = stall?.goods[index];
      if (!e || !stall || !now || now.itemId !== g.itemId || now.price !== g.price || now.count < n) {
        w.emit('character:grant', { entityId: id, gold: cost });
        return say(w, id, 'The stall’s stock changed before you could pay. Your gold is returned.', 'bad');
      }
      const left = w.give(id, g.itemId, n);
      const sold = n - left;
      if (left > 0) w.emit('character:grant', { entityId: id, gold: left * g.price });
      if (sold <= 0) return say(w, id, 'Your pack is full.', 'bad');
      const goods = stall.goods.map((x, i) => (i === index ? { ...x, count: x.count - sold } : x)).filter((x) => x.count > 0);
      save(w, e, { ...stall, goods, till: stall.till + sold * g.price });
      const what = itemName(w, g.itemId, sold);
      say(w, id, `You buy ${what} from ${labelOf(stall)} for ${sold * g.price} gold.${left > 0 ? ' Your pack could not hold the rest.' : ''}`, 'good');
      const owner = w.query('player').find((p) => nameOf(p) === stall.owner);
      if (owner) say(w, owner.id, `⛺ ${name} bought ${what} from your stall for ${sold * g.price} gold.`, 'good');
      w.log(`stall ${stall.owner}: ${name} bought ${what}`);
    },
  });
}

type Args = Record<string, unknown>;
const args = (a: unknown): Args => (typeof a === 'object' && a !== null ? (a as Args) : {});

export default definePlugin({
  id: 'stalls',
  items: ITEMS,
  recipes: RECIPES,
  entityKinds: [KIND],

  systems: [],

  commands: [
    { name: 'stalls:place', fn: (world, a, id) => place(world, id, args(a).slot) },
    { name: 'stalls:browse', fn: () => {} },
    { name: 'stalls:stock', fn: (world, a, id) => stock(world, id, args(a)) },
    { name: 'stalls:unstock', fn: (world, a, id) => unstock(world, id, args(a)) },
    { name: 'stalls:price', fn: (world, a, id) => reprice(world, id, args(a)) },
    { name: 'stalls:name', fn: (world, a, id) => rename(world, id, args(a)) },
    { name: 'stalls:collect', fn: (world, a, id) => collect(world, id, args(a)) },
    { name: 'stalls:pack', fn: (world, a, id) => packUp(world, id, args(a)) },
    { name: 'stalls:buy', fn: (world, a, id) => buy(world, id, args(a)) },
  ],

  events: {},
});
