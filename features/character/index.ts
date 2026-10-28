import {
  definePlugin,
  isStatsComponent,
  OVERWORLD,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  type EntityState,
  type InventoryComponent,
  type ItemDef,
  type StatsComponent,
  type WorldAPI,
} from '@game/shared';

/**
 * Who a player is: a name, experience and levels, gold, equipment, and what
 * happens when they fall. Everything about a player's growth lives here;
 * other features hand out rewards by emitting events rather than touching
 * the `character` component:
 *
 *   'character:grant'  { entityId, xp?, gold?, reason? }
 *   'character:charge' { entityId, gold, then(world, ok) }   — spend gold
 *
 * Progress survives reconnects: the client keeps a private token and sends
 * 'character:claim' on connect; the record is stored with world.getSet.
 */

export interface EquipmentSlots {
  weapon?: string;
  armor?: string;
  charm?: string;
}

export interface CharacterComponent {
  name: string;
  xp: number;
  xpPrev: number;
  xpNext: number;
  gold: number;
  kills: number;
  deaths: number;
  equipment: EquipmentSlots;
  /** Index into LOOKS: which outfit this character wears. */
  look: number;
  /** Recent messages for this player's log; `n` only ever increases. */
  log: { n: number; text: string; tone: string }[];
}

interface SavedCharacter {
  name: string;
  level: number;
  xp: number;
  gold: number;
  kills: number;
  deaths: number;
  equipment: EquipmentSlots;
  hp: number;
  look?: number;
  inventory?: InventoryComponent;
}

/** Outfits from the temporary art's character sets. */
const LOOKS = [
  'farmer',
  ...Array.from({ length: 21 }, (_, i) => `villager-${String(i + 1).padStart(2, '0')}`),
];

function appearanceFor(look: number): { character: string; scale: number } {
  const n = LOOKS.length;
  return { character: LOOKS[((look % n) + n) % n], scale: 1.5 };
}

const BASE = { hp: 100, atk: 15, def: 5 };
const PER_LEVEL = { hp: 14, atk: 3, def: 2 };
const MAX_LEVEL = 30;

/** Total experience needed to reach `level`. */
export function xpForLevel(level: number): number {
  const l = level - 1;
  return 25 * l * l + 25 * l;
}

function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  return level;
}

const HEALS: Record<string, number> = {
  'character:bread': 25,
  'character:minor_draught': 45,
  'character:draught': 110,
  'character:greater_draught': 260,
};

type Gear = NonNullable<ItemDef['equip']>;
let gearById: Map<string, Gear> | null = null;

/** Gear stats from every installed feature's items; the registry is fixed after boot. */
function gearOf(world: WorldAPI, itemId: string | undefined): Gear | undefined {
  if (!itemId) return undefined;
  if (!gearById) {
    gearById = new Map();
    for (const def of world.queryItemsByTag('equipment')) if (def.equip) gearById.set(def.id, def.equip);
  }
  return gearById.get(itemId);
}

export const ITEMS: ItemDef[] = [
  { id: 'character:bread', name: 'Travel Bread', tags: ['consumable', 'food', 'merchandise'], stack: 20, value: 4, use: 'character:use', useLabel: 'Eat', icon: '🍞', description: 'Dense and filling. Restores 25 health.' },
  { id: 'character:minor_draught', name: 'Minor Healing Draught', tags: ['consumable', 'potion', 'merchandise'], stack: 10, value: 12, use: 'character:use', useLabel: 'Drink', icon: '🧪', description: 'A bitter herbal tonic. Restores 45 health.' },
  { id: 'character:draught', name: 'Healing Draught', tags: ['consumable', 'potion', 'merchandise'], stack: 10, value: 35, use: 'character:use', useLabel: 'Drink', icon: '⚗️', description: 'The alchemist’s good stuff. Restores 110 health.' },
  { id: 'character:greater_draught', name: 'Greater Draught', tags: ['consumable', 'potion'], stack: 10, value: 90, use: 'character:use', useLabel: 'Drink', icon: '🍷', description: 'Thick and red as heartwood. Restores 260 health.' },
  { id: 'character:rusty_sword', name: 'Rusty Sword', tags: ['weapon', 'equipment', 'merchandise'], stack: 1, value: 25, use: 'character:use', useLabel: 'Equip', icon: '🗡️', description: 'Better than bare hands. +4 attack.', equip: { slot: 'weapon', atk: 4 } },
  { id: 'character:iron_sword', name: 'Iron Sword', tags: ['weapon', 'equipment', 'merchandise'], stack: 1, value: 90, use: 'character:use', useLabel: 'Equip', icon: '⚔️', description: 'Honest smithing. +9 attack.', equip: { slot: 'weapon', atk: 9 } },
  { id: 'character:war_axe', name: 'Bearded War Axe', tags: ['weapon', 'equipment', 'merchandise'], stack: 1, value: 240, use: 'character:use', useLabel: 'Equip', icon: '🪓', description: 'Heavy enough to argue with. +15 attack.', equip: { slot: 'weapon', atk: 15 } },
  { id: 'character:runed_blade', name: 'Runed Blade', tags: ['weapon', 'equipment'], stack: 1, value: 600, use: 'character:use', useLabel: 'Equip', icon: '🔪', description: 'Etched with marks nobody remembers. +24 attack.', equip: { slot: 'weapon', atk: 24 } },
  { id: 'character:leather_jerkin', name: 'Leather Jerkin', tags: ['armor', 'equipment', 'merchandise'], stack: 1, value: 30, use: 'character:use', useLabel: 'Equip', icon: '🦺', description: 'Boiled leather, well oiled. +3 defense.', equip: { slot: 'armor', def: 3 } },
  { id: 'character:chain_mail', name: 'Chain Mail', tags: ['armor', 'equipment', 'merchandise'], stack: 1, value: 130, use: 'character:use', useLabel: 'Equip', icon: '🥋', description: 'Rings on rings. +7 defense.', equip: { slot: 'armor', def: 7 } },
  { id: 'character:scale_hauberk', name: 'Scale Hauberk', tags: ['armor', 'equipment'], stack: 1, value: 380, use: 'character:use', useLabel: 'Equip', icon: '🛡️', description: 'Overlapping plates. +12 defense, +20 health.', equip: { slot: 'armor', def: 12, hp: 20 } },
  { id: 'character:wolf_tooth_charm', name: 'Wolf-Tooth Charm', tags: ['charm', 'equipment', 'merchandise'], stack: 1, value: 70, use: 'character:use', useLabel: 'Equip', icon: '📿', description: 'Hunters swear by it. +30 health.', equip: { slot: 'charm', hp: 30 } },
  { id: 'character:ember_charm', name: 'Ember Charm', tags: ['charm', 'equipment'], stack: 1, value: 260, use: 'character:use', useLabel: 'Equip', icon: '🔥', description: 'Warm to the touch, always. +5 attack, +20 health.', equip: { slot: 'charm', atk: 5, hp: 20 } },
];

const FIRST = ['Aldric', 'Bryn', 'Cael', 'Dara', 'Edda', 'Fenn', 'Garrow', 'Hesk', 'Ilsa', 'Jory', 'Kestrel', 'Lorn', 'Mira', 'Nell', 'Orrin', 'Perrin', 'Quill', 'Rowan', 'Sable', 'Tamsin', 'Ulric', 'Vesna', 'Wren', 'Yara'];
const EPITHET = ['of the Ford', 'Ashborn', 'the Quiet', 'Thornwood', 'the Red', 'Stillwater', 'of Hollow Hill', 'Greycloak', 'the Wanderer', 'Brightmoor'];

const REGEN_EVERY = 10;
const REGEN_AFTER_HIT = 60;
const SAVE_EVERY = 50;
const RESPAWN = { x: WORLD_CENTER_X, y: WORLD_CENTER_Y + 1 };

// Process-local: which connection token belongs to which entity, the last
// tick each entity was hit, and a dirty set for saving. None of it needs to
// survive a restart: tokens are re-claimed on reconnect.
const tokens = new Map<number, string>();
/** Tick each player was first seen without a character; a claim gets a moment to arrive. */
const firstSeen = new Map<number, number>();
const CLAIM_GRACE = 15;
const lastHit = new Map<number, number>();
const dirty = new Set<number>();
let clock = 0;

const floor = (n: number): number => n | 0;

function isCharacter(value: unknown): value is CharacterComponent {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.name === 'string' && typeof c.xp === 'number' && typeof c.gold === 'number';
}

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

function bonuses(world: WorldAPI, equipment: EquipmentSlots): { atk: number; def: number; hp: number } {
  const total = { atk: 0, def: 0, hp: 0 };
  for (const id of Object.values(equipment)) {
    const gear = gearOf(world, id);
    if (!gear) continue;
    total.atk += gear.atk ?? 0;
    total.def += gear.def ?? 0;
    total.hp += gear.hp ?? 0;
  }
  return total;
}

/** Stats as they follow from level and gear; hp is carried over, clamped. */
function deriveStats(world: WorldAPI, level: number, equipment: EquipmentSlots, hp: number): StatsComponent {
  const b = bonuses(world, equipment);
  const maxHp = BASE.hp + PER_LEVEL.hp * (level - 1) + b.hp;
  return {
    level,
    maxHp,
    hp: hp > maxHp ? maxHp : hp,
    atk: BASE.atk + PER_LEVEL.atk * (level - 1) + b.atk,
    def: BASE.def + PER_LEVEL.def * (level - 1) + b.def,
  };
}

function pushLog(c: CharacterComponent, text: string, tone: string): void {
  const n = (c.log[c.log.length - 1]?.n ?? 0) + 1;
  c.log = [...c.log.slice(-5), { n, text, tone }];
}

function freshCharacter(world: WorldAPI): CharacterComponent {
  const name = `${FIRST[floor(world.rng() * FIRST.length)]} ${EPITHET[floor(world.rng() * EPITHET.length)]}`;
  return {
    name,
    xp: 0,
    xpPrev: 0,
    xpNext: xpForLevel(2),
    gold: 15,
    kills: 0,
    deaths: 0,
    equipment: {},
    look: floor(world.rng() * LOOKS.length),
    log: [],
  };
}

function createCharacter(world: WorldAPI, e: EntityState): void {
  const stats = e.components.stats;
  const c = freshCharacter(world);
  pushLog(c, `You are ${c.name}. The village elder has been asking for help.`, 'quest');
  const hp = isStatsComponent(stats) ? stats.hp : BASE.hp;
  world.update(e.id, { character: c, stats: deriveStats(world, 1, {}, hp), appearance: appearanceFor(c.look) });
  firstSeen.delete(e.id);
}

function read(world: WorldAPI, id: number) {
  const e = world.get(id);
  if (!e) return undefined;
  const c = e.components.character;
  const s = e.components.stats;
  if (!isCharacter(c) || !isStatsComponent(s)) return undefined;
  return { e, c: { ...c, equipment: { ...c.equipment }, log: [...c.log] }, s: { ...s } };
}

function save(world: WorldAPI, id: number): void {
  const token = tokens.get(id);
  const r = read(world, id);
  if (!token || !r) return;
  const record: SavedCharacter = {
    name: r.c.name,
    level: r.s.level,
    xp: r.c.xp,
    gold: r.c.gold,
    kills: r.c.kills,
    deaths: r.c.deaths,
    equipment: r.c.equipment,
    hp: r.s.hp,
    look: r.c.look,
    inventory: isInventory(r.e.components.inventory) ? r.e.components.inventory : undefined,
  };
  world.getSet(`character:save:${token}`, JSON.stringify(record));
}

function grant(
  world: WorldAPI,
  id: number,
  xp: number,
  gold: number,
  reason?: string,
  tone = 'loot',
): void {
  const r = read(world, id);
  if (!r) return;
  const { c } = r;
  if (gold > 0) c.gold += gold;
  if (reason) pushLog(c, reason, tone);
  if (xp > 0) {
    c.xp += xp;
    const level = levelForXp(c.xp);
    if (level > r.s.level) {
      const stats = deriveStats(world, level, c.equipment, 0);
      stats.hp = stats.maxHp;
      pushLog(c, `You reached level ${level}! (+${PER_LEVEL.hp} health, +${PER_LEVEL.atk} attack, +${PER_LEVEL.def} defense)`, 'level');
      world.update(id, { stats });
    }
    c.xpPrev = xpForLevel(level);
    c.xpNext = xpForLevel(level < MAX_LEVEL ? level + 1 : level);
  }
  world.update(id, { character: c });
  dirty.add(id);
}

/** Remove one item from a slot of the player's (core-owned) inventory. */
function takeFromSlot(world: WorldAPI, id: number, slot: number): string | undefined {
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

function useItem(world: WorldAPI, id: number, slot: number): void {
  const e = world.get(id);
  const inv = e?.components.inventory;
  if (!isInventory(inv)) return;
  const itemId = inv.slots[slot]?.itemId;
  const heal = itemId ? HEALS[itemId] : undefined;
  const gear = gearOf(world, itemId);
  const r = read(world, id);
  if ((heal === undefined && !gear) || !r || !itemId) return;
  const name =
    ITEMS.find((i) => i.id === itemId)?.name ??
    world.queryItemsByTag('equipment').find((i) => i.id === itemId)?.name ??
    itemId;

  if (heal !== undefined) {
    if (r.s.hp >= r.s.maxHp) {
      pushLog(r.c, 'You are already at full health.', 'info');
      world.update(id, { character: r.c });
      return;
    }
    if (!takeFromSlot(world, id, slot)) return;
    const hp = r.s.hp + heal > r.s.maxHp ? r.s.maxHp : r.s.hp + heal;
    world.update(id, { stats: { ...r.s, hp } });
    dirty.add(id);
    return;
  }

  if (!gear || !takeFromSlot(world, id, slot)) return;
  const previous = r.c.equipment[gear.slot];
  r.c.equipment[gear.slot] = itemId;
  if (previous) {
    const left = world.give(id, previous, 1);
    if (left > 0) {
      r.c.equipment[gear.slot] = previous;
      world.give(id, itemId, 1);
      pushLog(r.c, 'Your pack is too full to swap gear.', 'bad');
      world.update(id, { character: r.c });
      return;
    }
  }
  pushLog(r.c, `You equip the ${name}.`, 'good');
  world.update(id, { character: r.c, stats: deriveStats(world, r.s.level, r.c.equipment, r.s.hp) });
  dirty.add(id);
}

function unequip(world: WorldAPI, id: number, slotName: unknown): void {
  if (slotName !== 'weapon' && slotName !== 'armor' && slotName !== 'charm') return;
  const r = read(world, id);
  const itemId = r?.c.equipment[slotName];
  if (!r || !itemId) return;
  if (world.give(id, itemId, 1) > 0) {
    pushLog(r.c, 'No room in your pack.', 'bad');
    world.update(id, { character: r.c });
    return;
  }
  delete r.c.equipment[slotName];
  world.update(id, { character: r.c, stats: deriveStats(world, r.s.level, r.c.equipment, r.s.hp) });
  dirty.add(id);
}

function respawn(world: WorldAPI, id: number, killerName: string): void {
  const r = read(world, id);
  if (!r) return;
  const lost = floor(r.c.gold * 0.1);
  r.c.gold -= lost;
  r.c.deaths += 1;
  pushLog(r.c, `You were slain by ${killerName}${lost > 0 ? ` and dropped ${lost} gold` : ''}. You wake in the village.`, 'death');
  world.update(id, { character: r.c, stats: { ...r.s, hp: r.s.maxHp } });
  world.travel(id, OVERWORLD, RESPAWN.x, RESPAWN.y);
  lastHit.delete(id);
  dirty.add(id);
}

function claim(world: WorldAPI, id: number, args: unknown): void {
  const token = (args as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || !/^[a-z0-9]{16,64}$/.test(token)) return;
  for (const [other, t] of tokens) {
    if (t === token && other !== id && world.get(other)) {
      save(world, other);
      tokens.delete(other);
    }
  }
  tokens.set(id, token);
  const raw = world.getSet(`character:save:${token}`);
  const e = world.get(id);
  if (!e) return;
  if (!raw) {
    if (!isCharacter(e.components.character)) createCharacter(world, e);
    save(world, id);
    return;
  }
  let saved: SavedCharacter;
  try {
    saved = JSON.parse(raw) as SavedCharacter;
  } catch {
    return;
  }
  const c = freshCharacter(world);
  c.name = typeof saved.name === 'string' ? saved.name : c.name;
  c.xp = saved.xp | 0;
  c.gold = saved.gold | 0;
  c.kills = saved.kills | 0;
  c.deaths = saved.deaths | 0;
  if (typeof saved.look === 'number') c.look = saved.look | 0;
  c.equipment = Object.fromEntries(
    Object.entries(saved.equipment ?? {}).filter(([, v]) => typeof v === 'string' && gearOf(world, v)),
  ) as EquipmentSlots;
  const level = levelForXp(c.xp);
  c.xpPrev = xpForLevel(level);
  c.xpNext = xpForLevel(level + 1);
  pushLog(c, `Welcome back, ${c.name}.`, 'info');
  firstSeen.delete(id);
  const stats = deriveStats(world, level, c.equipment, saved.hp > 0 ? saved.hp : 1);
  const patch: Record<string, unknown> = { character: c, stats, appearance: appearanceFor(c.look) };
  if (saved.inventory && isInventory(saved.inventory)) patch.inventory = saved.inventory;
  world.update(id, patch);
}

function rename(world: WorldAPI, id: number, args: unknown): void {
  const raw = (args as { name?: unknown } | undefined)?.name;
  if (typeof raw !== 'string') return;
  const name = raw.replace(/[^\p{L}\p{N} '-]/gu, '').trim().slice(0, 24);
  const r = read(world, id);
  if (!r || name.length < 2) return;
  r.c.name = name;
  world.update(id, { character: r.c });
  dirty.add(id);
}

function changeLook(world: WorldAPI, id: number, args: unknown): void {
  const step = readNumber(args, 'step') === -1 ? -1 : 1;
  const r = read(world, id);
  if (!r) return;
  r.c.look = (((r.c.look ?? 0) + step) % LOOKS.length + LOOKS.length) % LOOKS.length;
  world.update(id, { character: r.c, appearance: appearanceFor(r.c.look) });
  dirty.add(id);
}

function readNumber(args: unknown, key: string): number | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

export default definePlugin({
  id: 'character',
  items: ITEMS,
  recipes: [],
  entityKinds: [],

  systems: [
    {
      name: 'character:tick',
      fn: (world) => {
        clock++;
        for (const p of world.query('player', 'stats')) {
          const stats = p.components.stats;
          if (!isStatsComponent(stats)) continue;
          if (!isCharacter(p.components.character)) {
            const seen = firstSeen.get(p.id);
            if (seen === undefined) firstSeen.set(p.id, clock);
            else if (clock - seen >= CLAIM_GRACE) createCharacter(world, p);
            continue;
          }
          if (stats.hp <= 0) continue;
          if (clock % REGEN_EVERY === 0 && stats.hp < stats.maxHp) {
            const since = clock - (lastHit.get(p.id) ?? -1000);
            if (since >= REGEN_AFTER_HIT) {
              const amount = floor(stats.maxHp * 0.04) || 1;
              const hp = stats.hp + amount > stats.maxHp ? stats.maxHp : stats.hp + amount;
              world.update(p.id, { stats: { ...stats, hp } });
            }
          }
        }
        if (clock % SAVE_EVERY === 0) {
          for (const id of dirty) save(world, id);
          dirty.clear();
          for (const id of tokens.keys()) if (!world.get(id)) tokens.delete(id);
          for (const id of lastHit.keys()) if (!world.get(id)) lastHit.delete(id);
          for (const id of firstSeen.keys()) if (!world.get(id)) firstSeen.delete(id);
        }
      },
    },
  ],

  commands: [
    {
      name: 'character:use',
      fn: (world, args, entityId) => {
        const slot = readNumber(args, 'slot');
        if (slot !== undefined) useItem(world, entityId, slot);
      },
    },
    {
      name: 'character:unequip',
      fn: (world, args, entityId) =>
        unequip(world, entityId, (args as { slot?: unknown } | undefined)?.slot),
    },
    { name: 'character:claim', fn: (world, args, entityId) => claim(world, entityId, args) },
    { name: 'character:rename', fn: (world, args, entityId) => rename(world, entityId, args) },
    { name: 'character:look', fn: (world, args, entityId) => changeLook(world, entityId, args) },
  ],

  events: {
    'entity:damage': (_world, payload) => {
      const targetId = (payload as { targetId?: unknown }).targetId;
      if (typeof targetId === 'number') lastHit.set(targetId, clock);
    },
    'combat:killed': (world, payload) => {
      const ev = payload as { victimId?: number; killerId?: number; kind?: string };
      if (typeof ev.victimId !== 'number') return;
      if (ev.kind === 'player') {
        const killer = typeof ev.killerId === 'number' ? world.get(ev.killerId) : undefined;
        const name =
          (killer?.components.name as string | undefined) ??
          (isCharacter(killer?.components.character) ? killer.components.character.name : 'something');
        respawn(world, ev.victimId, name);
        return;
      }
      if (typeof ev.killerId === 'number') {
        const r = read(world, ev.killerId);
        if (r) {
          r.c.kills += 1;
          world.update(ev.killerId, { character: r.c });
        }
      }
    },
    'character:grant': (world, payload) => {
      const p = payload as {
        entityId?: unknown;
        xp?: unknown;
        gold?: unknown;
        reason?: unknown;
        tone?: unknown;
      };
      if (typeof p.entityId !== 'number') return;
      const xp = typeof p.xp === 'number' && p.xp > 0 ? floor(p.xp) : 0;
      const gold = typeof p.gold === 'number' && p.gold > 0 ? floor(p.gold) : 0;
      const reason = typeof p.reason === 'string' ? p.reason : undefined;
      grant(world, p.entityId, xp, gold, reason, typeof p.tone === 'string' ? p.tone : 'loot');
    },
    'character:charge': (world, payload) => {
      const p = payload as { entityId?: unknown; gold?: unknown; then?: unknown };
      if (typeof p.entityId !== 'number' || typeof p.gold !== 'number' || p.gold < 0) return;
      const r = read(world, p.entityId);
      const ok = r !== undefined && r.c.gold >= p.gold;
      if (r && ok) {
        r.c.gold -= floor(p.gold);
        world.update(p.entityId, { character: r.c });
        dirty.add(p.entityId);
      }
      if (typeof p.then === 'function') (p.then as (w: WorldAPI, ok: boolean) => void)(world, ok);
    },
  },
});
