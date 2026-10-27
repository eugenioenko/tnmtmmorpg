import {
  definePlugin,
  isStatsComponent,
  type EntityState,
  type InventoryComponent,
  type WorldAPI,
} from '@game/shared';

/**
 * Player-to-player trading. One player asks ('trade:request'), the other
 * accepts, and both get a trade window. Each side puts up items from its
 * pack and some gold, then locks its offer; once both are locked each side
 * accepts, and the swap happens in one step. Any change to either offer
 * unlocks both, so nobody can swap something in after the other side looked.
 *
 * Everything a player sees lives in their private `trade:state`, so the
 * terms of a deal never reach a bystander's client. Gold belongs to the
 * character feature and moves through its 'character:charge' and
 * 'character:grant' events.
 */

export interface OfferItem {
  slot: number;
  itemId: string;
  count: number;
}

interface Offer {
  items: OfferItem[];
  gold: number;
  locked: boolean;
  accepted: boolean;
}

interface Session {
  id: number;
  a: number;
  b: number;
  offers: Map<number, Offer>;
  busy: boolean;
}

export interface TradeView {
  partnerId: number;
  partnerName: string;
  mine: Offer;
  theirs: { items: { itemId: string; count: number }[]; gold: number; locked: boolean; accepted: boolean };
}

export interface TradeState {
  incoming?: { fromId: number; fromName: string };
  outgoing?: { toId: number; toName: string };
  session?: TradeView;
  notice?: { n: number; text: string; tone: 'good' | 'bad' | 'info' };
}

const REQUEST_RANGE = 4;
const KEEP_RANGE = 8;
const REQUEST_TICKS = 300;
const MAX_ITEMS = 8;

let clock = 0;
let nextSession = 1;
/** Pending request: target id -> who asked and when. */
const requests = new Map<number, { fromId: number; at: number }>();
const sessions = new Map<number, Session>();
const sessionOf = new Map<number, number>();
const notices = new Map<number, number>();

function nameOf(e: EntityState | undefined): string {
  const c = e?.components.character as { name?: unknown } | undefined;
  if (typeof c?.name === 'string') return c.name;
  return e ? `Wanderer ${e.id}` : 'Someone';
}

function goldOf(e: EntityState | undefined): number | undefined {
  const c = e?.components.character as { gold?: unknown } | undefined;
  return typeof c?.gold === 'number' ? c.gold : undefined;
}

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function inventoryOf(e: EntityState | undefined): InventoryComponent | undefined {
  const inv = e?.components.inventory;
  return isInventory(inv) ? inv : undefined;
}

function alive(e: EntityState | undefined): e is EntityState {
  if (!e) return false;
  const stats = e.components.stats;
  return !isStatsComponent(stats) || stats.hp > 0;
}

function distance(a: EntityState, b: EntityState): number {
  const dx = a.x > b.x ? a.x - b.x : b.x - a.x;
  const dy = a.y > b.y ? a.y - b.y : b.y - a.y;
  return dx > dy ? dx : dy;
}

function near(a: EntityState, b: EntityState, range: number): boolean {
  return a.world === b.world && distance(a, b) <= range;
}

function emptyOffer(): Offer {
  return { items: [], gold: 0, locked: false, accepted: false };
}

function stateOf(world: WorldAPI, id: number): TradeState {
  const raw = world.get(id)?.components['trade:state'];
  return typeof raw === 'object' && raw !== null ? (raw as TradeState) : {};
}

function notify(world: WorldAPI, id: number, text: string, tone: 'good' | 'bad' | 'info'): void {
  const n = (notices.get(id) ?? 0) + 1;
  notices.set(id, n);
  world.update(id, { 'trade:state': { ...stateOf(world, id), notice: { n, text, tone } } });
}

/** Rewrite one player's private view from the authoritative maps. */
function publish(world: WorldAPI, id: number): void {
  const me = world.get(id);
  if (!me) return;
  const state: TradeState = { notice: stateOf(world, id).notice };
  const req = requests.get(id);
  if (req) state.incoming = { fromId: req.fromId, fromName: nameOf(world.get(req.fromId)) };
  for (const [target, r] of requests) {
    if (r.fromId === id) state.outgoing = { toId: target, toName: nameOf(world.get(target)) };
  }
  const sid = sessionOf.get(id);
  const s = sid === undefined ? undefined : sessions.get(sid);
  if (s) {
    const partnerId = s.a === id ? s.b : s.a;
    const mine = s.offers.get(id) ?? emptyOffer();
    const theirs = s.offers.get(partnerId) ?? emptyOffer();
    state.session = {
      partnerId,
      partnerName: nameOf(world.get(partnerId)),
      mine: { ...mine, items: mine.items.map((i) => ({ ...i })) },
      theirs: {
        items: theirs.items.map((i) => ({ itemId: i.itemId, count: i.count })),
        gold: theirs.gold,
        locked: theirs.locked,
        accepted: theirs.accepted,
      },
    };
  }
  world.update(id, { 'trade:state': state });
}

function unlockBoth(s: Session): void {
  for (const offer of s.offers.values()) {
    offer.locked = false;
    offer.accepted = false;
  }
}

function endSession(world: WorldAPI, s: Session, reason?: string): void {
  sessions.delete(s.id);
  for (const id of [s.a, s.b]) {
    sessionOf.delete(id);
    if (reason) notify(world, id, reason, 'bad');
    publish(world, id);
  }
}

function sessionFor(id: number): Session | undefined {
  const sid = sessionOf.get(id);
  return sid === undefined ? undefined : sessions.get(sid);
}

function request(world: WorldAPI, fromId: number, args: unknown): void {
  const targetId = (args as { targetId?: unknown } | undefined)?.targetId;
  if (typeof targetId !== 'number' || targetId === fromId) return;
  const me = world.get(fromId);
  const them = world.get(targetId);
  if (!me || !them || them.kind !== 'player') return;
  if (!alive(me) || !alive(them)) return;
  if (!near(me, them, REQUEST_RANGE)) {
    notify(world, fromId, `${nameOf(them)} is too far away to trade.`, 'bad');
    return;
  }
  if (sessionOf.has(fromId)) return;
  if (sessionOf.has(targetId)) {
    notify(world, fromId, `${nameOf(them)} is already trading.`, 'bad');
    return;
  }
  const theirs = requests.get(fromId);
  if (theirs?.fromId === targetId) {
    open(world, targetId, fromId);
    return;
  }
  for (const [target, r] of requests) {
    if (r.fromId === fromId) {
      requests.delete(target);
      publish(world, target);
    }
  }
  const existing = requests.get(targetId);
  if (existing && existing.fromId !== fromId && clock - existing.at < REQUEST_TICKS) {
    notify(world, fromId, `${nameOf(them)} is considering another offer.`, 'bad');
    return;
  }
  requests.set(targetId, { fromId, at: clock });
  publish(world, targetId);
  publish(world, fromId);
}

function respond(world: WorldAPI, id: number, args: unknown): void {
  const req = requests.get(id);
  if (!req) return;
  requests.delete(id);
  const accept = (args as { accept?: unknown } | undefined)?.accept === true;
  const me = world.get(id);
  const them = world.get(req.fromId);
  if (!accept || !me || !them) {
    if (them) notify(world, them.id, `${nameOf(me)} declined to trade.`, 'info');
    publish(world, id);
    if (them) publish(world, them.id);
    return;
  }
  if (!near(me, them, KEEP_RANGE) || sessionOf.has(them.id) || sessionOf.has(id)) {
    notify(world, id, 'That trade is no longer possible.', 'bad');
    publish(world, id);
    publish(world, them.id);
    return;
  }
  open(world, them.id, id);
}

function open(world: WorldAPI, a: number, b: number): void {
  requests.delete(a);
  requests.delete(b);
  for (const [target, r] of requests) {
    if (r.fromId === a || r.fromId === b) {
      requests.delete(target);
      publish(world, target);
    }
  }
  const s: Session = {
    id: nextSession++,
    a,
    b,
    offers: new Map([
      [a, emptyOffer()],
      [b, emptyOffer()],
    ]),
    busy: false,
  };
  sessions.set(s.id, s);
  sessionOf.set(a, s.id);
  sessionOf.set(b, s.id);
  publish(world, a);
  publish(world, b);
}

function readInt(args: unknown, key: string): number | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** Changing an offer in any way unlocks both sides. */
function edit(world: WorldAPI, id: number, change: (offer: Offer, me: EntityState) => boolean): void {
  const s = sessionFor(id);
  const me = world.get(id);
  const offer = s?.offers.get(id);
  if (!s || !me || !offer || s.busy) return;
  if (!change(offer, me)) return;
  unlockBoth(s);
  publish(world, s.a);
  publish(world, s.b);
}

function offerItem(world: WorldAPI, id: number, args: unknown): void {
  const slot = readInt(args, 'slot');
  const wanted = readInt(args, 'count');
  edit(world, id, (offer, me) => {
    const cell = slot === undefined ? undefined : inventoryOf(me)?.slots[slot];
    if (slot === undefined || !cell || cell.count <= 0) return false;
    const count = wanted !== undefined && wanted > 0 && wanted < cell.count ? wanted : cell.count;
    const existing = offer.items.find((i) => i.slot === slot);
    if (existing) {
      existing.itemId = cell.itemId;
      existing.count = count;
      return true;
    }
    if (offer.items.length >= MAX_ITEMS) return false;
    offer.items.push({ slot, itemId: cell.itemId, count });
    return true;
  });
}

function removeItem(world: WorldAPI, id: number, args: unknown): void {
  const index = readInt(args, 'index');
  edit(world, id, (offer) => {
    if (index === undefined || index < 0 || index >= offer.items.length) return false;
    offer.items.splice(index, 1);
    return true;
  });
}

function setGold(world: WorldAPI, id: number, args: unknown): void {
  const amount = readInt(args, 'amount');
  edit(world, id, (offer, me) => {
    const have = goldOf(me) ?? 0;
    if (amount === undefined || amount < 0) return false;
    const gold = amount > have ? have : amount;
    if (gold === offer.gold) return false;
    offer.gold = gold;
    return true;
  });
}

function lock(world: WorldAPI, id: number, args: unknown): void {
  const s = sessionFor(id);
  const offer = s?.offers.get(id);
  if (!s || !offer || s.busy) return;
  const locked = (args as { locked?: unknown } | undefined)?.locked !== false;
  if (locked === offer.locked) return;
  if (!locked) unlockBoth(s);
  else offer.locked = true;
  publish(world, s.a);
  publish(world, s.b);
}

function accept(world: WorldAPI, id: number): void {
  const s = sessionFor(id);
  const offer = s?.offers.get(id);
  if (!s || !offer || s.busy) return;
  const all = [...s.offers.values()];
  if (!all.every((o) => o.locked)) return;
  offer.accepted = true;
  publish(world, s.a);
  publish(world, s.b);
  if (all.every((o) => o.accepted)) execute(world, s);
}

/** Does the pack still hold everything this offer promised? */
function offerStillValid(inv: InventoryComponent | undefined, offer: Offer): boolean {
  if (!inv) return offer.items.length === 0;
  return offer.items.every((i) => {
    const cell = inv.slots[i.slot];
    return cell !== undefined && cell.itemId === i.itemId && cell.count >= i.count;
  });
}

function without(inv: InventoryComponent, offer: Offer): InventoryComponent {
  const slots = inv.slots.map((s) => ({ ...s }));
  for (const i of offer.items) {
    const cell = slots[i.slot];
    cell.count -= i.count;
    if (cell.count <= 0) slots[i.slot] = { itemId: '', count: 0 };
  }
  return { ...inv, slots };
}

/**
 * The swap. Gold is taken from both sides first (through the character
 * feature, which answers asynchronously), then the items move; if either
 * pack cannot hold what it is getting, everything is put back.
 */
function execute(world: WorldAPI, s: Session): void {
  s.busy = true;
  const a = world.get(s.a);
  const b = world.get(s.b);
  const offerA = s.offers.get(s.a) ?? emptyOffer();
  const offerB = s.offers.get(s.b) ?? emptyOffer();
  const fail = (reason: string): void => endSession(world, s, reason);

  if (!a || !b) return fail('Trade cancelled.');
  if (!offerStillValid(inventoryOf(a), offerA) || !offerStillValid(inventoryOf(b), offerB)) {
    return fail('Trade failed: an offered item is no longer in its pack.');
  }
  if ((goldOf(a) ?? 0) < offerA.gold || (goldOf(b) ?? 0) < offerB.gold) {
    return fail('Trade failed: not enough gold.');
  }

  const refund = (id: number, gold: number): void => {
    if (gold > 0) world.emit('character:grant', { entityId: id, gold });
  };

  const moveItems = (): void => {
    const nowA = world.get(s.a);
    const nowB = world.get(s.b);
    const invA = inventoryOf(nowA);
    const invB = inventoryOf(nowB);
    if (!nowA || !nowB || !invA || !invB || !offerStillValid(invA, offerA) || !offerStillValid(invB, offerB)) {
      refund(s.a, offerA.gold);
      refund(s.b, offerB.gold);
      return fail('Trade failed: an offered item is no longer in its pack.');
    }
    world.update(s.a, { inventory: without(invA, offerA) });
    world.update(s.b, { inventory: without(invB, offerB) });
    let overflow = 0;
    for (const i of offerB.items) overflow += world.give(s.a, i.itemId, i.count);
    for (const i of offerA.items) overflow += world.give(s.b, i.itemId, i.count);
    if (overflow > 0) {
      world.update(s.a, { inventory: invA });
      world.update(s.b, { inventory: invB });
      refund(s.a, offerA.gold);
      refund(s.b, offerB.gold);
      return fail('Trade failed: not enough room in a pack.');
    }
    const nameA = nameOf(nowA);
    const nameB = nameOf(nowB);
    if (offerB.gold > 0) world.emit('character:grant', { entityId: s.a, gold: offerB.gold });
    if (offerA.gold > 0) world.emit('character:grant', { entityId: s.b, gold: offerA.gold });
    endSession(world, s);
    notify(world, s.a, `Trade with ${nameB} complete.`, 'good');
    notify(world, s.b, `Trade with ${nameA} complete.`, 'good');
    world.log(`trade #${s.id}: ${nameA} <-> ${nameB}`);
  };

  const hasCharacter = goldOf(a) !== undefined && goldOf(b) !== undefined;
  if (!hasCharacter || (offerA.gold === 0 && offerB.gold === 0)) {
    moveItems();
    return;
  }
  world.emit('character:charge', {
    entityId: s.a,
    gold: offerA.gold,
    then: (_w: WorldAPI, okA: boolean) => {
      if (!okA) return fail('Trade failed: not enough gold.');
      world.emit('character:charge', {
        entityId: s.b,
        gold: offerB.gold,
        then: (_w2: WorldAPI, okB: boolean) => {
          if (!okB) {
            refund(s.a, offerA.gold);
            return fail('Trade failed: not enough gold.');
          }
          moveItems();
        },
      });
    },
  });
}

function cancel(world: WorldAPI, id: number): void {
  const s = sessionFor(id);
  if (s) {
    if (s.busy) return;
    const other = s.a === id ? s.b : s.a;
    endSession(world, s);
    notify(world, other, `${nameOf(world.get(id))} cancelled the trade.`, 'info');
    notify(world, id, 'Trade cancelled.', 'info');
    return;
  }
  for (const [target, r] of requests) {
    if (r.fromId === id) {
      requests.delete(target);
      publish(world, target);
    }
  }
  publish(world, id);
}

export default definePlugin({
  id: 'trade',
  items: [],
  recipes: [],
  entityKinds: [],
  privateComponents: ['trade:state'],

  systems: [
    {
      name: 'trade:watch',
      fn: (world) => {
        clock++;
        if (clock % 5 !== 0) return;
        for (const [target, r] of requests) {
          const t = world.get(target);
          const f = world.get(r.fromId);
          if (!t || !f || clock - r.at > REQUEST_TICKS || !near(t, f, KEEP_RANGE)) {
            requests.delete(target);
            if (t) publish(world, target);
            if (f) publish(world, r.fromId);
          }
        }
        for (const s of [...sessions.values()]) {
          if (s.busy) continue;
          const a = world.get(s.a);
          const b = world.get(s.b);
          if (!alive(a) || !alive(b)) {
            endSession(world, s, 'Trade cancelled.');
            continue;
          }
          if (!near(a, b, KEEP_RANGE)) {
            endSession(world, s, 'Trade cancelled: you walked too far apart.');
            continue;
          }
          let changed = false;
          for (const [id, offer] of s.offers) {
            const inv = inventoryOf(id === s.a ? a : b);
            const kept = offer.items.filter((i) => offerStillValid(inv, { ...offer, items: [i] }));
            if (kept.length !== offer.items.length) {
              offer.items = kept;
              changed = true;
            }
          }
          if (changed) {
            unlockBoth(s);
            publish(world, s.a);
            publish(world, s.b);
          }
        }
        if (clock % 600 === 0) {
          for (const id of notices.keys()) if (!world.get(id)) notices.delete(id);
        }
      },
    },
  ],

  commands: [
    { name: 'trade:request', fn: (world, args, id) => request(world, id, args) },
    { name: 'trade:respond', fn: (world, args, id) => respond(world, id, args) },
    { name: 'trade:offer-item', fn: (world, args, id) => offerItem(world, id, args) },
    { name: 'trade:remove-item', fn: (world, args, id) => removeItem(world, id, args) },
    { name: 'trade:gold', fn: (world, args, id) => setGold(world, id, args) },
    { name: 'trade:lock', fn: (world, args, id) => lock(world, id, args) },
    { name: 'trade:accept', fn: (world, _args, id) => accept(world, id) },
    { name: 'trade:cancel', fn: (world, _args, id) => cancel(world, id) },
  ],

  events: {},
});
