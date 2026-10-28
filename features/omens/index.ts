import {
  definePlugin,
  isStatsComponent,
  OVERWORLD,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  type EntityState,
  type ItemDef,
  type WorldAPI,
} from '@game/shared';

/**
 * Omens: world bosses. Every so often a great beast rises somewhere near
 * the players, and the whole realm is told. Everyone who lands a blow
 * before it falls shares the spoils: experience, gold, an Omen Shard, and a
 * chance at the Omen Charm (the one who hit hardest always gets one). Left
 * alone, it slinks back into the wilds after LINGER ticks.
 *
 * The beast itself comes from the bestiary ('bestiary:spawn' with a boss
 * name and title). Hits are counted from combat's 'entity:damage', which is
 * spatial: it arrives once per nearby entity, so only the copy delivered to
 * the boss itself counts. Rewards go out through 'character:grant'.
 *
 * Each player carries a private `omens:alert` the client turns into a
 * banner and a tracker with the beast's health, distance and direction.
 */

export interface OmenAlert {
  n: number;
  state: 'risen' | 'slain' | 'fled';
  name: string;
  title: string;
  world: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  level: number;
  slayers?: string[];
}

export const ITEMS: ItemDef[] = [
  { id: 'omens:shard', name: 'Omen Shard', tags: ['loot', 'trophy'], stack: 20, value: 60, icon: '🔮', description: 'A sliver of something that should not have walked the earth. Odo pays well for these.' },
  { id: 'omens:charm', name: 'Omen Charm', tags: ['charm', 'equipment'], stack: 1, value: 300, use: 'character:use', useLabel: 'Equip', icon: '🧿', description: 'Taken from a fallen omen. +6 attack, +40 health.', equip: { slot: 'charm', atk: 6, hp: 40 } },
];

const NAMES = ['Old Hollowgut', 'Gnashfang', 'Ashmaw', 'Thornhide', 'Grimbristle', 'The Pale Glutton', 'Mirehorn', 'Skulljaw'];
const SITE: Record<string, string> = { n: 'Northern', s: 'Southern', e: 'Eastern', w: 'Western' };

const FIRST = Number(globalThis.process?.env?.OMENS_FIRST_SECONDS) > 0 ? Number(globalThis.process?.env?.OMENS_FIRST_SECONDS) * 10 : 3000;
const EVERY = 15000;
const JITTER = 6000;
const LINGER = 9000;
const SHARE_RANGE = 40;
const SAFE_RADIUS = 26;

interface Omen {
  id?: number;
  n: number;
  name: string;
  title: string;
  level: number;
  world: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  born: number;
  damage: Map<number, number>;
  missing?: number;
}

let clock = 0;
let nextAt = FIRST;
let seq = 0;
let omen: Omen | undefined;
let last: OmenAlert | undefined;
let lastUntil = 0;

const floor = (n: number): number => n | 0;
const abs = (n: number): number => (n < 0 ? -n : n);

function nameOf(e: EntityState | undefined): string | undefined {
  const c = e?.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : undefined;
}

function alertOf(o: Omen, state: OmenAlert['state'], slayers?: string[]): OmenAlert {
  return { n: o.n, state, name: o.name, title: o.title, world: o.world, x: o.x, y: o.y, hp: o.hp, maxHp: o.maxHp, level: o.level, slayers };
}

function broadcast(world: WorldAPI, alert: OmenAlert | undefined): void {
  for (const p of world.query('player')) {
    const mine = p.components['omens:alert'] as OmenAlert | undefined;
    if (JSON.stringify(mine ?? null) === JSON.stringify(alert ?? null)) continue;
    world.update(p.id, { 'omens:alert': alert });
  }
}

function rise(world: WorldAPI): void {
  const players = world
    .query('player')
    .filter((p) => (p.world ?? OVERWORLD) === OVERWORLD && isStatsComponent(p.components.stats) && p.components.stats.hp > 0);
  if (players.length === 0) return;
  const anchor = players[floor(world.rng() * players.length)];
  let top = 1;
  for (const p of players) {
    const s = p.components.stats;
    if (isStatsComponent(s) && s.level > top) top = s.level;
  }
  for (let tries = 0; tries < 40; tries++) {
    const dist = 30 + floor(world.rng() * 16);
    const along = floor((world.rng() * 2 - 1) * dist);
    const sign = world.rng() < 0.5 ? -1 : 1;
    const flip = world.rng() < 0.5;
    const x = anchor.x + (flip ? along : sign * dist);
    const y = anchor.y + (flip ? sign * dist : along);
    if (abs(x - WORLD_CENTER_X) < SAFE_RADIUS && abs(y - WORLD_CENTER_Y) < SAFE_RADIUS) continue;
    if (!world.walkable(x, y, OVERWORLD)) continue;
    const dx = x - WORLD_CENTER_X;
    const dy = y - WORLD_CENTER_Y;
    const side = abs(dx) > abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
    const level = top + 2 < 4 ? 4 : top + 2;
    const o: Omen = {
      n: ++seq,
      name: NAMES[floor(world.rng() * NAMES.length)],
      title: `Terror of the ${SITE[side]} Wilds`,
      level,
      world: OVERWORLD,
      x,
      y,
      hp: 1,
      maxHp: 1,
      born: clock,
      damage: new Map(),
    };
    omen = o;
    world.emit('bestiary:spawn', {
      world: OVERWORLD,
      x,
      y,
      level,
      boss: { name: o.name, title: o.title },
      then: (w: WorldAPI, id: number) => {
        if (omen !== o) return;
        o.id = id;
        const e = w.get(id);
        const s = e?.components.stats;
        if (isStatsComponent(s)) {
          o.hp = s.hp;
          o.maxHp = s.maxHp;
        }
        w.log(`${o.name}, ${o.title} (level ${level}) rises at ${x},${y}`);
        broadcast(w, alertOf(o, 'risen'));
      },
    });
    return;
  }
}

function end(world: WorldAPI, o: Omen, state: 'slain' | 'fled', slayers?: string[]): void {
  omen = undefined;
  last = alertOf(o, state, slayers);
  lastUntil = clock + 300;
  broadcast(world, last);
  nextAt = clock + EVERY + floor(world.rng() * JITTER);
}

function reward(world: WorldAPI, o: Omen, x: number, y: number): string[] {
  const ranked = [...o.damage.entries()].sort((a, b) => b[1] - a[1]);
  const names: string[] = [];
  ranked.forEach(([id], i) => {
    const p = world.get(id);
    const name = nameOf(p);
    if (!p || !name || (p.world ?? OVERWORLD) !== o.world) return;
    if (abs(p.x - x) > SHARE_RANGE || abs(p.y - y) > SHARE_RANGE) return;
    names.push(name);
    const xp = 120 + o.level * 25;
    const gold = 30 + floor(world.rng() * 40) + o.level * 3;
    const charm = i === 0 || world.rng() < 0.35;
    for (const [item, n] of [['omens:shard', 1], ...(charm ? [['omens:charm', 1]] : [])] as [string, number][]) {
      const left = world.give(p.id, item, n);
      if (left > 0) world.spawn('item', { x: p.x, y: p.y }, { itemDrop: { itemId: item, count: left } }, p.world);
    }
    world.emit('character:grant', {
      entityId: p.id,
      xp,
      gold,
      reason: `${o.name} is slain! Your share: +${xp} XP, ${gold} gold, an Omen Shard${charm ? ' and an Omen Charm' : ''}.`,
      tone: 'level',
    });
  });
  return names;
}

export default definePlugin({
  id: 'omens',
  items: ITEMS,
  recipes: [],
  entityKinds: [],
  privateComponents: ['omens:alert'],

  systems: [
    {
      name: 'omens:tick',
      fn: (world) => {
        clock++;
        if (clock % 10 !== 0) return;
        const o = omen;
        if (!o) {
          if (last && clock >= lastUntil) {
            last = undefined;
            broadcast(world, undefined);
          } else if (last) broadcast(world, last);
          if (clock >= nextAt) {
            nextAt = clock + 600;
            rise(world);
          }
          return;
        }
        if (o.id === undefined) {
          if (clock - o.born > 50) {
            omen = undefined;
            nextAt = clock + 600;
          }
          return;
        }
        const e = world.get(o.id);
        if (!e) {
          // Combat despawns the beast before its 'combat:killed' flushes; give the kill a moment to land.
          o.missing = (o.missing ?? 0) + 1;
          if (o.missing >= 3) end(world, o, 'fled');
          return;
        }
        if (clock - o.born > LINGER) {
          world.despawn(o.id);
          return end(world, o, 'fled');
        }
        const s = e.components.stats;
        if (isStatsComponent(s)) {
          o.hp = s.hp;
          o.maxHp = s.maxHp;
        }
        o.x = e.x;
        o.y = e.y;
        broadcast(world, alertOf(o, 'risen'));
      },
    },
  ],

  commands: [],

  events: {
    'entity:damage': (world, payload) => {
      const ev = payload as { entityId?: unknown; targetId?: unknown; sourceId?: unknown; amount?: unknown };
      const o = omen;
      if (!o || o.id === undefined || ev.targetId !== o.id || ev.entityId !== o.id) return;
      if (typeof ev.sourceId !== 'number' || typeof ev.amount !== 'number') return;
      if (world.get(ev.sourceId)?.kind !== 'player') return;
      o.damage.set(ev.sourceId, (o.damage.get(ev.sourceId) ?? 0) + ev.amount);
    },
    'combat:killed': (world, payload) => {
      const ev = payload as { victimId?: unknown; killerId?: unknown; x?: unknown; y?: unknown };
      const o = omen;
      if (!o || o.id === undefined || ev.victimId !== o.id) return;
      if (typeof ev.killerId === 'number' && world.get(ev.killerId)?.kind === 'player' && !o.damage.has(ev.killerId)) {
        o.damage.set(ev.killerId, 1);
      }
      o.hp = 0;
      const x = typeof ev.x === 'number' ? ev.x : o.x;
      const y = typeof ev.y === 'number' ? ev.y : o.y;
      end(world, o, 'slain', reward(world, o, x, y));
    },
  },
});
