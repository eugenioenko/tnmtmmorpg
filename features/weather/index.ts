import { definePlugin, OVERWORLD, type ItemDef, type LightComponent, type RecipeDef, type WorldAPI } from '@game/shared';
import { skyAt, type Weather } from './sky.ts';

/**
 * Weather: rain fronts, storms, fog, snow, dust and ash, drifting east
 * across the world (see sky.ts). Nothing is stored; every server computes
 * the same sky from the wall clock.
 *
 * Each player carries a private `weather:here` for the sky over them,
 * which the client draws and the sound feature listens to. Storms throw
 * lightning; now and then a bolt lands nearby and fuses the ground into
 * stormglass that can be dug out before it cools.
 */

const SCORCH = 'weather:scorch';
const SCORCH_MS = 60_000;
const STRIKABLE = new Set(['grass', 'dirt', 'forest', 'swamp', 'sand', 'snow', 'mountain']);

const ITEMS: ItemDef[] = [
  { id: 'weather:stormglass', name: 'Stormglass', tags: ['loot', 'gem'], stack: 20, value: 35, icon: '💠', description: 'Sand and soil fused by lightning. It still hums. The forge can set three into a charm.' },
  { id: 'weather:storm_charm', name: 'Storm Charm', tags: ['charm', 'equipment', 'crafted'], stack: 1, value: 240, use: 'character:use', useLabel: 'Equip', icon: '🌩️', description: 'Three shards of stormglass bound in copper. +4 attack, +25 health.', equip: { slot: 'charm', atk: 4, hp: 25 } },
];

const RECIPES: RecipeDef[] = [
  {
    id: 'weather:storm_charm',
    station: 'professions:forge',
    inputs: [{ id: 'weather:stormglass', count: 3 }],
    outputs: [{ id: 'weather:storm_charm', count: 1 }],
    ticks: 30,
  },
];

const STRIKE_LIGHT: LightComponent = { radius: 2.6, color: 0x9fc4ff, flicker: 0.5, intensity: 0.9 };

/** Server-side only: WEATHER_FORCE=storm (or storm:0.9) pins every outdoor sky, to preview it locally. */
const FORCE = String(globalThis.process?.env?.WEATHER_FORCE ?? '').split(':');

let clock = 0;
let hour = 12;

function say(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

const same = (a: Weather | undefined, b: Weather): boolean =>
  !!a && a.sky === b.sky && (a.amount - b.amount < 0.04 && b.amount - a.amount < 0.04) && (a.wind - b.wind < 0.08 && b.wind - a.wind < 0.08);

/** Land a bolt a few tiles from a player, on open ground nobody is standing on. */
function strike(world: WorldAPI, x: number, y: number, place: string): void {
  for (let tries = 0; tries < 8; tries++) {
    const sx = x + ((world.rng() * 19) | 0) - 9;
    const sy = y + ((world.rng() * 19) | 0) - 9;
    if (sx - x < 4 && x - sx < 4 && sy - y < 4 && y - sy < 4) continue;
    if (!STRIKABLE.has(world.tile(sx, sy, place)) || !world.walkable(sx, sy, place)) continue;
    if (world.queryNear(sx, sy, 1, place).length > 0) continue;
    world.spawn(
      SCORCH,
      { x: sx, y: sy },
      {
        [SCORCH]: { until: Date.now() + SCORCH_MS },
        appearance: { emoji: '💠', scale: 0.6 },
        name: 'Fused ground',
        light: STRIKE_LIGHT,
      },
      place,
    );
    return;
  }
}

function update(world: WorldAPI): void {
  const now = Date.now();
  for (const p of world.query('player')) {
    const place = p.world ?? OVERWORLD;
    let next = skyAt(place, world.tile(p.x, p.y, place), p.x, p.y, now, hour);
    if (FORCE[0] && !place.startsWith('interior:') && !place.startsWith('dungeon:')) next = { sky: FORCE[0] as Weather['sky'], amount: Number(FORCE[1] ?? 0.8), wind: 0.7 };
    const mine = p.components['weather:here'] as Weather | undefined;
    const stormy = next.sky === 'storm' || next.sky === 'blizzard';
    if (stormy && world.rng() < 0.07 * next.amount) {
      world.update(p.id, { 'weather:here': { ...next, flash: now } satisfies Weather });
      if (next.sky === 'storm' && world.rng() < 0.4 && world.query(SCORCH).length < 40) strike(world, p.x, p.y, place);
      continue;
    }
    if (same(mine, next)) continue;
    world.update(p.id, { 'weather:here': { ...next, flash: mine?.flash } satisfies Weather });
  }
  for (const s of world.query(SCORCH)) {
    const until = (s.components[SCORCH] as { until?: number } | undefined)?.until ?? 0;
    if (until <= now) world.despawn(s.id);
  }
}

function dig(world: WorldAPI, id: number, targetId: unknown): void {
  const me = world.get(id);
  const target = typeof targetId === 'number' ? world.get(targetId) : undefined;
  if (!me || !target || target.components[SCORCH] === undefined) return;
  const dx = me.x > target.x ? me.x - target.x : target.x - me.x;
  const dy = me.y > target.y ? me.y - target.y : target.y - me.y;
  if ((me.world ?? OVERWORLD) !== (target.world ?? OVERWORLD) || dx > 1 || dy > 1) return;
  const count = world.rng() < 0.25 ? 2 : 1;
  const left = world.give(id, 'weather:stormglass', count);
  if (left >= count) {
    say(world, id, 'Your pack is full.', 'bad');
    return;
  }
  world.despawn(target.id);
  say(world, id, `You pry ${count - left === 1 ? 'a shard' : 'two shards'} of stormglass from the fused earth.`, 'loot');
  world.emit('weather:dug', { entityId: id, count: count - left });
}

export default definePlugin({
  id: 'weather',
  items: ITEMS,
  recipes: RECIPES,
  entityKinds: [SCORCH],
  privateComponents: ['weather:here'],

  systems: [
    {
      name: 'weather:tick',
      fn: (world) => {
        clock++;
        if (clock % 10 === 3) update(world);
      },
    },
  ],

  commands: [
    {
      name: 'weather:dig',
      fn: (world, args, id) => dig(world, id, (args as { targetId?: unknown } | undefined)?.targetId),
    },
  ],

  events: {
    'daynight:hour': (_world, payload) => {
      const h = (payload as { hour?: unknown }).hour;
      if (typeof h === 'number') hour = h;
    },
  },
});
