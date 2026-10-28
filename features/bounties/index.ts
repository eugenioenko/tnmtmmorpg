import {
  definePlugin,
  OVERWORLD,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  type EntityState,
  type InventoryComponent,
  type WorldAPI,
} from '@game/shared';

/**
 * The bounty board in the village square. Players pin up requests ("10 Wolf
 * Pelts, 8 gold each"); the gold is held by the board when posted, so anyone
 * who delivers is paid on the spot even while the poster is offline. The
 * goods wait on the board until the poster collects them. Withdrawing
 * refunds whatever was not yet delivered.
 *
 * The village posts a few notices of its own, which pay gold and experience
 * and expire after TOWN_MS. Everything lives on the board entity, so it
 * persists with the world. Every action needs the player at the board.
 */

export interface Bounty {
  id: number;
  /** Character name of the poster, or a villager's name for town notices. */
  by: string;
  town?: boolean;
  itemId: string;
  want: number;
  got: number;
  /** Gold paid per item delivered. */
  each: number;
  /** Experience per item, town notices only. */
  xp?: number;
  /** Delivered goods waiting for the poster to collect. */
  stash: number;
  at: number;
  until?: number;
}

export interface Board {
  seq: number;
  posts: Bounty[];
}

export const KIND = 'bounties:board';
export const RANGE = 3;
export const MAX_MINE = 3;
export const MAX_WANT = 50;
export const MAX_EACH = 500;
const MAX_PLAYER_POSTS = 18;
const TOWN_POSTS = 3;
const TOWN_MS = 90 * 60_000;
const CATALOG_TAGS = ['loot', 'material', 'produce', 'food', 'crafted', 'potion'];
const LOOK = { emoji: '🪧', scale: 1.7 };
const TOWN_POSTERS = ['Elder Aldous', 'Captain Brannoc', 'Morwen the Alchemist', 'Odo the Trader'];

let clock = 0;
let catalog: string[] | undefined;
let townPool: { id: string; value: number }[] = [];
const names = new Map<string, string>();

const floor = (n: number): number => n | 0;
const abs = (n: number): number => (n < 0 ? -n : n);

function catalogOf(world: WorldAPI): string[] {
  if (catalog) return catalog;
  const seen = new Map<string, { id: string; value: number; tags: string[] }>();
  for (const tag of CATALOG_TAGS) {
    for (const def of world.queryItemsByTag(tag)) {
      if (def.tags.includes('merchandise') || def.tags.includes('seed')) continue;
      seen.set(def.id, { id: def.id, value: def.value ?? 1, tags: def.tags });
      names.set(def.id, def.name);
    }
  }
  const all = [...seen.values()].sort((a, b) => a.value - b.value || (a.id < b.id ? -1 : 1));
  catalog = all.map((d) => d.id);
  townPool = all
    .filter((d) => d.value <= 30 && d.tags.some((t) => t === 'loot' || t === 'material' || t === 'produce') && !d.tags.includes('trophy'))
    .map((d) => ({ id: d.id, value: d.value }));
  return catalog;
}

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

function count(e: EntityState | undefined, itemId: string): number {
  const inv = e?.components.inventory;
  if (!isInventory(inv)) return 0;
  return inv.slots.reduce((n, s) => (s.itemId === itemId ? n + s.count : n), 0);
}

function take(world: WorldAPI, id: number, itemId: string, n: number): boolean {
  const e = world.get(id);
  const inv = e?.components.inventory;
  if (!isInventory(inv) || count(e, itemId) < n) return false;
  let left = n;
  const slots = inv.slots.map((s) => ({ ...s }));
  for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
    if (slots[i].itemId !== itemId) continue;
    const used = slots[i].count < left ? slots[i].count : left;
    slots[i].count -= used;
    left -= used;
    if (slots[i].count <= 0) slots[i] = { itemId: '', count: 0 };
  }
  world.update(id, { inventory: { ...inv, slots } });
  return true;
}

function say(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

function itemName(world: WorldAPI, itemId: string, n = 1): string {
  catalogOf(world);
  const name = names.get(itemId) ?? itemId;
  return n === 1 ? name : `${n} × ${name}`;
}

function boardEntity(world: WorldAPI): EntityState | undefined {
  return world.query(KIND)[0];
}

function boardOf(e: EntityState | undefined): Board {
  const b = e?.components['bounties:board'] as Board | undefined;
  return b && Array.isArray(b.posts) && typeof b.seq === 'number' ? b : { seq: 0, posts: [] };
}

function save(world: WorldAPI, e: EntityState, board: Board): void {
  world.update(e.id, { 'bounties:board': board });
}

/** The board, if this player is standing at it. */
function atBoard(world: WorldAPI, id: number): { me: EntityState; e: EntityState; board: Board } | undefined {
  const me = world.get(id);
  const e = boardEntity(world);
  if (!me || !e) return undefined;
  if ((me.world ?? OVERWORLD) !== (e.world ?? OVERWORLD) || abs(me.x - e.x) > RANGE || abs(me.y - e.y) > RANGE) {
    say(world, id, 'You need to be at the bounty board in the village square.', 'bad');
    return undefined;
  }
  return { me, e, board: boardOf(e) };
}

function intArg(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? floor(v) : 0;
}

function post(world: WorldAPI, id: number, args: Record<string, unknown>): void {
  const at = atBoard(world, id);
  const name = nameOf(at?.me);
  if (!at || !name) return;
  const itemId = typeof args.itemId === 'string' ? args.itemId : '';
  const want = intArg(args.want);
  const each = intArg(args.each);
  if (!catalogOf(world).includes(itemId)) return say(world, id, 'The board only takes requests for gathered goods and crafted wares.', 'bad');
  if (want < 1 || want > MAX_WANT) return say(world, id, `Ask for between 1 and ${MAX_WANT}.`, 'bad');
  if (each < 1 || each > MAX_EACH) return say(world, id, `Offer between 1 and ${MAX_EACH} gold each.`, 'bad');
  const mine = at.board.posts.filter((p) => !p.town && p.by === name && p.got < p.want).length;
  if (mine >= MAX_MINE) return say(world, id, `You already have ${MAX_MINE} open bounties. Withdraw one first.`, 'bad');
  if (at.board.posts.filter((p) => !p.town).length >= MAX_PLAYER_POSTS) return say(world, id, 'The board is full. Come back when some bounties are filled.', 'bad');
  const escrow = want * each;
  if (goldOf(at.me) < escrow) return say(world, id, `That needs ${escrow} gold up front; you carry ${goldOf(at.me)}.`, 'bad');
  world.emit('character:charge', {
    entityId: id,
    gold: escrow,
    then: (w: WorldAPI, ok: boolean) => {
      if (!ok) return say(w, id, 'Not enough gold.', 'bad');
      const e = boardEntity(w);
      if (!e) {
        w.emit('character:grant', { entityId: id, gold: escrow });
        return;
      }
      const board = boardOf(e);
      const bounty: Bounty = { id: board.seq + 1, by: name, itemId, want, got: 0, each, stash: 0, at: Date.now() };
      save(w, e, { seq: board.seq + 1, posts: [...board.posts, bounty] });
      const what = itemName(w, itemId, want);
      say(w, id, `Bounty posted: ${what} at ${each} gold each. The board holds your ${escrow} gold.`, 'good');
      for (const p of w.query('player')) {
        if (p.id !== id) say(w, p.id, `📜 ${name} posted a bounty: ${what}, ${each} gold each.`);
      }
      w.log(`bounty #${bounty.id}: ${name} wants ${what} at ${each}g`);
    },
  });
}

function deliver(world: WorldAPI, id: number, args: Record<string, unknown>): void {
  const at = atBoard(world, id);
  const name = nameOf(at?.me);
  if (!at || !name) return;
  const b = at.board.posts.find((p) => p.id === args.id);
  if (!b || b.got >= b.want) return say(world, id, 'That bounty has already been filled.', 'bad');
  if (!b.town && b.by === name) return say(world, id, 'You cannot fill your own bounty.', 'bad');
  const have = count(at.me, b.itemId);
  const asked = intArg(args.count);
  let n = b.want - b.got;
  if (have < n) n = have;
  if (asked > 0 && asked < n) n = asked;
  if (n <= 0) return say(world, id, `You carry no ${itemName(world, b.itemId)}.`, 'bad');
  if (!take(world, id, b.itemId, n)) return;
  const filled = b.got + n >= b.want;
  const next: Bounty = { ...b, got: b.got + n, stash: b.town ? 0 : b.stash + n };
  const posts = at.board.posts.map((p) => (p.id === b.id ? next : p)).filter((p) => !(p.town && p.got >= p.want));
  save(world, at.e, { ...at.board, posts });
  const gold = n * b.each;
  const xp = b.town ? n * (b.xp ?? 0) : 0;
  const what = itemName(world, b.itemId, n);
  world.emit('character:grant', {
    entityId: id,
    gold,
    xp: xp > 0 ? xp : undefined,
    reason: `You deliver ${what} for ${b.by}: +${gold} gold${xp > 0 ? `, +${xp} XP` : ''}.${filled ? ' Bounty filled!' : ''}`,
    tone: 'good',
  });
  world.emit('bounties:delivered', { entityId: id, count: n });
  if (!b.town) {
    const poster = world.query('player').find((p) => nameOf(p) === b.by);
    if (poster) say(world, poster.id, `📜 ${name} delivered ${what} to your bounty. Collect it at the board.`, 'good');
  }
  world.log(`bounty #${b.id}: ${name} delivered ${what}`);
}

function collect(world: WorldAPI, id: number, args: Record<string, unknown>, withdraw: boolean): void {
  const at = atBoard(world, id);
  const name = nameOf(at?.me);
  if (!at || !name) return;
  const b = at.board.posts.find((p) => p.id === args.id);
  if (!b || b.town || b.by !== name) return;
  const refund = withdraw ? (b.want - b.got) * b.each : 0;
  const left = b.stash > 0 ? world.give(id, b.itemId, b.stash) : 0;
  const taken = b.stash - left;
  const next: Bounty = { ...b, stash: left, want: withdraw ? b.got : b.want };
  const done = next.got >= next.want && next.stash === 0;
  const posts = done ? at.board.posts.filter((p) => p.id !== b.id) : at.board.posts.map((p) => (p.id === b.id ? next : p));
  save(world, at.e, { ...at.board, posts });
  const parts: string[] = [];
  if (taken > 0) parts.push(`you collect ${itemName(world, b.itemId, taken)}`);
  if (refund > 0) parts.push(`${refund} gold comes back to you`);
  if (left > 0) parts.push(`your pack is full, ${left} still wait on the board`);
  if (refund > 0) world.emit('character:grant', { entityId: id, gold: refund });
  if (parts.length === 0) return say(world, id, withdraw ? 'Bounty withdrawn.' : 'Nothing has been delivered yet.');
  const text = parts.join('; ');
  say(world, id, `${withdraw ? 'Bounty withdrawn: ' : ''}${text[0].toUpperCase()}${text.slice(1)}.`, left > 0 ? 'bad' : 'good');
}

function refreshTown(world: WorldAPI, e: EntityState): void {
  catalogOf(world);
  const now = Date.now();
  const board = boardOf(e);
  let posts = board.posts.filter((p) => !p.town || (p.until ?? 0) > now);
  let seq = board.seq;
  const open = posts.filter((p) => p.town).length;
  for (let i = open; i < TOWN_POSTS && townPool.length > 0; i++) {
    const taken = new Set(posts.map((p) => p.itemId));
    const choices = townPool.filter((d) => !taken.has(d.id));
    if (choices.length === 0) break;
    const pick = choices[floor(world.rng() * choices.length)];
    const raw = floor(48 / pick.value);
    const want = raw < 3 ? 3 : raw > 12 ? 12 : raw;
    posts = [
      ...posts,
      {
        id: ++seq,
        by: TOWN_POSTERS[floor(world.rng() * TOWN_POSTERS.length)],
        town: true,
        itemId: pick.id,
        want,
        got: 0,
        each: floor(pick.value * 1.6) + 1,
        xp: pick.value * 3 + 4,
        stash: 0,
        at: now,
        until: now + TOWN_MS - floor(world.rng() * 20) * 60_000,
      },
    ];
  }
  if (seq !== board.seq || posts.length !== board.posts.length) save(world, e, { seq, posts });
  if (JSON.stringify(e.components.appearance) !== JSON.stringify(LOOK)) world.update(e.id, { appearance: LOOK });
  const cat = catalogOf(world);
  if (JSON.stringify(e.components['bounties:catalog'] ?? null) !== JSON.stringify(cat)) world.update(e.id, { 'bounties:catalog': cat });
}

function raise(world: WorldAPI): void {
  for (let r = 0; r < 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = WORLD_CENTER_X + 2 + dx;
        const y = WORLD_CENTER_Y - 2 + dy;
        if (!world.walkable(x, y, OVERWORLD) || world.queryNear(x, y, 1, OVERWORLD).length > 0) continue;
        world.spawn(KIND, { x, y }, { label: 'Bounty Board', appearance: LOOK, 'bounties:board': { seq: 0, posts: [] } }, OVERWORLD);
        world.log('bounty board raised in the village square');
        return;
      }
    }
  }
}

export default definePlugin({
  id: 'bounties',
  items: [],
  recipes: [],
  entityKinds: [KIND],

  systems: [
    {
      name: 'bounties:tick',
      fn: (world) => {
        clock++;
        if (clock === 30 && world.tile(WORLD_CENTER_X, WORLD_CENTER_Y, OVERWORLD) === 'dirt' && world.getSet('bounties:board-v1') === undefined) {
          world.getSet('bounties:board-v1', '1');
          raise(world);
        }
        if (clock % 600 !== 40) return;
        const e = boardEntity(world);
        if (e) refreshTown(world, e);
      },
    },
  ],

  commands: [
    { name: 'bounties:read', fn: () => {} },
    { name: 'bounties:post', fn: (world, args, id) => post(world, id, (args ?? {}) as Record<string, unknown>) },
    { name: 'bounties:deliver', fn: (world, args, id) => deliver(world, id, (args ?? {}) as Record<string, unknown>) },
    { name: 'bounties:collect', fn: (world, args, id) => collect(world, id, (args ?? {}) as Record<string, unknown>, false) },
    { name: 'bounties:withdraw', fn: (world, args, id) => collect(world, id, (args ?? {}) as Record<string, unknown>, true) },
  ],

  events: {},
});
