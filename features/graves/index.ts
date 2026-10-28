import {
  definePlugin,
  isCarvedWorld,
  OVERWORLD,
  resolveWorld,
  type EntityState,
  type InventoryComponent,
  type WorldAPI,
} from '@game/shared';

/**
 * Death has a price. When a player falls outdoors, everything they had
 * gathered (loot, materials, produce, trophies) stays behind in a grave
 * where they fell. Gear, tools, potions and food stay in the pack. The
 * owner, or anyone in their party, can reclaim it; after OPEN_MS anyone
 * can; after CRUMBLE_MS it is gone. Caves and interiors keep no graves:
 * their copies are torn down, so nothing is dropped there.
 *
 * The owner carries a private `graves:mine` while a grave of theirs
 * stands, for the client's tracker. Graves are keyed by character name and
 * timed by the wall clock, so they survive logouts and restarts.
 */

export interface GraveItem {
  itemId: string;
  count: number;
}

export interface GraveComponent {
  owner: string;
  at: number;
  items: GraveItem[];
}

export interface MyGrave {
  x: number;
  y: number;
  world: string;
  /** Wall-clock ms when it opens to anyone, and when it crumbles. */
  opens: number;
  crumbles: number;
  count: number;
}

const DROP_TAGS = ['loot', 'material', 'produce', 'trophy'];
const KEEP_TAGS = ['equipment', 'tool', 'consumable'];
export const OPEN_MS = 10 * 60_000;
export const CRUMBLE_MS = 30 * 60_000;

let droppable: Set<string> | undefined;
let clock = 0;

function dropSet(world: WorldAPI): Set<string> {
  if (droppable) return droppable;
  droppable = new Set();
  for (const tag of DROP_TAGS) {
    for (const def of world.queryItemsByTag(tag)) {
      if (!def.tags.some((t) => KEEP_TAGS.includes(t))) droppable.add(def.id);
    }
  }
  return droppable;
}

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function graveOf(e: EntityState | undefined): GraveComponent | undefined {
  const g = e?.components['graves:grave'] as GraveComponent | undefined;
  return g && typeof g.owner === 'string' && Array.isArray(g.items) ? g : undefined;
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

function total(items: GraveItem[]): number {
  return items.reduce((n, i) => n + i.count, 0);
}

function bury(world: WorldAPI, victimId: number, x: number, y: number, where: string): void {
  if (isCarvedWorld(resolveWorld(where))) return;
  const me = world.get(victimId);
  const name = nameOf(me);
  const inv = me?.components.inventory;
  if (!me || !name || !isInventory(inv)) return;
  const drop = dropSet(world);
  const items: GraveItem[] = [];
  const slots = inv.slots.map((s) => {
    if (s.count <= 0 || !drop.has(s.itemId)) return { ...s };
    const same = items.find((i) => i.itemId === s.itemId);
    if (same) same.count += s.count;
    else items.push({ itemId: s.itemId, count: s.count });
    return { itemId: '', count: 0 };
  });
  if (items.length === 0) return;
  world.update(victimId, { inventory: { ...inv, slots } });
  const grave: GraveComponent = { owner: name, at: Date.now(), items };
  world.spawn('graves:grave', { x, y }, { 'graves:grave': grave, label: `${name}’s grave`, appearance: { emoji: '🪦', scale: 1.1 } }, where);
  say(world, victimId, `Your spoils (${total(items)} items) lie on your grave. Reclaim them within ${OPEN_MS / 60_000} minutes, before anyone else can.`, 'bad');
}

function reclaim(world: WorldAPI, id: number, targetId: unknown): void {
  const me = world.get(id);
  const target = typeof targetId === 'number' ? world.get(targetId) : undefined;
  const grave = graveOf(target);
  const name = nameOf(me);
  if (!me || !target || !grave || !name) return;
  if ((me.world ?? OVERWORLD) !== (target.world ?? OVERWORLD)) return;
  if ((me.x - target.x) ** 2 > 1 || (me.y - target.y) ** 2 > 1) return;
  const mine = grave.owner === name;
  const owner = world.query('player').find((p) => nameOf(p) === grave.owner);
  const party = partyOf(me) !== undefined && partyOf(me) === partyOf(owner);
  if (!mine && !party && Date.now() - grave.at < OPEN_MS) {
    return say(world, id, `${grave.owner}’s grave. It is not yours to disturb, not yet.`, 'bad');
  }
  const left: GraveItem[] = [];
  let taken = 0;
  for (const item of grave.items) {
    const rest = world.give(id, item.itemId, item.count);
    taken += item.count - rest;
    if (rest > 0) left.push({ itemId: item.itemId, count: rest });
  }
  if (left.length === 0) world.despawn(target.id);
  else world.update(target.id, { 'graves:grave': { ...grave, items: left } });
  const whose = mine ? 'your belongings' : `${grave.owner}’s belongings`;
  if (taken === 0) return say(world, id, 'Your pack is too full to take anything.', 'bad');
  say(world, id, `You reclaim ${whose} (${taken} item${taken > 1 ? 's' : ''})${left.length ? '; your pack is full, the rest remains' : ''}.`, 'good');
}

function refresh(world: WorldAPI): void {
  const now = Date.now();
  const byOwner = new Map<string, EntityState>();
  for (const e of world.query('graves:grave')) {
    const g = graveOf(e);
    if (!g) continue;
    if (now - g.at > CRUMBLE_MS) {
      world.despawn(e.id);
      continue;
    }
    const prev = byOwner.get(g.owner);
    if (!prev || (graveOf(prev)?.at ?? 0) < g.at) byOwner.set(g.owner, e);
  }
  for (const p of world.query('player')) {
    const name = nameOf(p);
    const e = name ? byOwner.get(name) : undefined;
    const g = graveOf(e);
    const next: MyGrave | undefined =
      e && g
        ? { x: e.x, y: e.y, world: e.world ?? OVERWORLD, opens: g.at + OPEN_MS, crumbles: g.at + CRUMBLE_MS, count: total(g.items) }
        : undefined;
    if (JSON.stringify(p.components['graves:mine'] ?? null) === JSON.stringify(next ?? null)) continue;
    world.update(p.id, { 'graves:mine': next });
  }
}

export default definePlugin({
  id: 'graves',
  items: [],
  recipes: [],
  entityKinds: ['graves:grave'],
  privateComponents: ['graves:mine'],

  systems: [
    {
      name: 'graves:tick',
      fn: (world) => {
        clock++;
        if (clock % 20 === 0) refresh(world);
      },
    },
  ],

  commands: [{ name: 'graves:reclaim', fn: (world, args, id) => reclaim(world, id, (args as { targetId?: unknown } | undefined)?.targetId) }],

  events: {
    'combat:killed': (world, payload) => {
      const ev = payload as { victimId?: unknown; kind?: unknown; x?: unknown; y?: unknown; world?: unknown };
      if (ev.kind !== 'player' || typeof ev.victimId !== 'number' || typeof ev.x !== 'number' || typeof ev.y !== 'number') return;
      bury(world, ev.victimId, ev.x, ev.y, typeof ev.world === 'string' ? ev.world : OVERWORLD);
    },
  },
});
