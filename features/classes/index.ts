import {
  definePlugin,
  isStatsComponent,
  OVERWORLD,
  type EntityState,
  type PlayerEnterEvent,
  type WorldAPI,
} from '@game/shared';

/**
 * Classes: at level 5 a player chooses a path — Warrior, Ranger or Mystic —
 * and gains four abilities, unlocked at levels 5, 6, 8 and 11, paid for from
 * a pool that refills over time (Fury, Focus or Mana). Abilities have
 * cooldowns, a shared one-second global cooldown, and some take a moment to
 * cast; moving cancels a cast.
 *
 * This feature never touches hit points itself: damage goes through
 * combat's 'combat:strike', shields and marks through 'combat:modifier', and
 * healing through character's 'character:heal'. The chosen path persists with
 * the character, and can also be picked on the character creation screen.
 */

export type ClassId = 'warrior' | 'ranger' | 'mystic';

type Effect =
  | { kind: 'strike'; power: number; range: number; pierce?: number; element?: string; executeBelow?: number }
  | { kind: 'cleave'; power: number; radius: number; element?: string }
  | { kind: 'splash'; power: number; range: number; radius: number; element?: string }
  | { kind: 'poison'; power: number; range: number; dot: number; ticks: number }
  | { kind: 'heal'; fraction: number; ally: boolean }
  | { kind: 'guard'; taken: number; ticks: number; ally: boolean }
  | { kind: 'mark'; taken: number; ticks: number; range: number };

export interface Ability {
  id: string;
  name: string;
  icon: string;
  level: number;
  cost: number;
  cooldown: number;
  cast: number;
  text: string;
  effect: Effect;
}

export interface ClassDef {
  id: ClassId;
  name: string;
  icon: string;
  resource: string;
  color: string;
  blurb: string;
  abilities: Ability[];
}

export const CLASSES: Record<ClassId, ClassDef> = {
  warrior: {
    id: 'warrior',
    name: 'Warrior',
    icon: '🛡️',
    resource: 'Fury',
    color: '#e0624f',
    blurb: 'Stands in the thick of it. Hits everything nearby, shrugs off blows, and finishes what it starts.',
    abilities: [
      { id: 'cleave', name: 'Cleave', icon: '🪓', level: 5, cost: 20, cooldown: 40, cast: 0, text: 'Strike every enemy next to you for 120% attack.', effect: { kind: 'cleave', power: 1.2, radius: 1 } },
      { id: 'shield_wall', name: 'Shield Wall', icon: '🛡️', level: 6, cost: 25, cooldown: 200, cast: 0, text: 'Take 50% less damage for 6 seconds.', effect: { kind: 'guard', taken: 0.5, ticks: 60, ally: false } },
      { id: 'second_wind', name: 'Second Wind', icon: '💨', level: 8, cost: 30, cooldown: 300, cast: 0, text: 'Recover 30% of your health at once.', effect: { kind: 'heal', fraction: 0.3, ally: false } },
      { id: 'execute', name: 'Execute', icon: '⚔️', level: 11, cost: 35, cooldown: 80, cast: 0, text: 'A crushing blow for 250% attack; double against foes under 30% health.', effect: { kind: 'strike', power: 2.5, range: 1, executeBelow: 0.3 } },
    ],
  },
  ranger: {
    id: 'ranger',
    name: 'Ranger',
    icon: '🏹',
    resource: 'Focus',
    color: '#8fd16f',
    blurb: 'Fights from a distance. Picks targets apart with arrows and poison before they ever reach you.',
    abilities: [
      { id: 'aimed_shot', name: 'Aimed Shot', icon: '🏹', level: 5, cost: 15, cooldown: 20, cast: 10, text: 'A careful shot at up to 6 tiles for 160% attack.', effect: { kind: 'strike', power: 1.6, range: 6 } },
      { id: 'volley', name: 'Volley', icon: '🎯', level: 6, cost: 30, cooldown: 100, cast: 0, text: 'Arrows rain on your target and everything within 2 tiles of it, 100% attack.', effect: { kind: 'splash', power: 1, range: 6, radius: 2 } },
      { id: 'venom_arrow', name: 'Venom Arrow', icon: '🧪', level: 8, cost: 20, cooldown: 80, cast: 0, text: 'A barbed shot for 60% attack, then poison for 25% attack every second for 5 seconds.', effect: { kind: 'poison', power: 0.6, range: 6, dot: 0.25, ticks: 5 } },
      { id: 'hunters_mark', name: "Hunter's Mark", icon: '🔻', level: 11, cost: 25, cooldown: 150, cast: 0, text: 'Your target takes 30% more damage from everyone for 10 seconds.', effect: { kind: 'mark', taken: 1.3, ticks: 100, range: 8 } },
    ],
  },
  mystic: {
    id: 'mystic',
    name: 'Mystic',
    icon: '🔮',
    resource: 'Mana',
    color: '#6fb6ff',
    blurb: 'Bends fire and frost, mends wounds and wards friends. Fragile, and worth protecting.',
    abilities: [
      { id: 'firebolt', name: 'Firebolt', icon: '🔥', level: 5, cost: 20, cooldown: 0, cast: 15, text: 'Hurl fire up to 6 tiles for 200% attack, half ignoring armour.', effect: { kind: 'strike', power: 2, range: 6, pierce: 0.5, element: 'fire' } },
      { id: 'mend', name: 'Mend', icon: '✨', level: 6, cost: 25, cooldown: 40, cast: 12, text: 'Restore 35% health to yourself, or to the player you have targeted.', effect: { kind: 'heal', fraction: 0.35, ally: true } },
      { id: 'frost_nova', name: 'Frost Nova', icon: '❄️', level: 8, cost: 35, cooldown: 120, cast: 0, text: 'Freezing air bursts out to 2 tiles: 110% attack to every enemy caught.', effect: { kind: 'cleave', power: 1.1, radius: 2, element: 'frost' } },
      { id: 'arcane_shield', name: 'Arcane Shield', icon: '🔰', level: 11, cost: 30, cooldown: 250, cast: 0, text: 'You, or your targeted ally, take 40% less damage for 8 seconds.', effect: { kind: 'guard', taken: 0.6, ticks: 80, ally: true } },
    ],
  },
};

export const CHOOSE_LEVEL = 5;
const GCD = 10;
const REGEN_EVERY = 10;
const REGEN = 4;
const RESPEC_GOLD = 50;

export interface ClassState {
  cls: ClassId | null;
  mana: number;
  maxMana: number;
  /** Ticks left on each ability's cooldown (only those cooling). */
  cd: Record<string, number>;
  gcd: number;
  casting?: { n: number; ability: string; label: string; ms: number };
}

interface Cast {
  ability: Ability;
  targetId?: number;
  x: number;
  y: number;
  doneAt: number;
}

interface Poison {
  casterId: number;
  targetId: number;
  power: number;
  left: number;
}

let clock = 0;
let castSeq = 0;
const casts = new Map<number, Cast>();
const poisons: Poison[] = [];

const floor = (n: number): number => n | 0;
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const dx = a.x > b.x ? a.x - b.x : b.x - a.x;
  const dy = a.y > b.y ? a.y - b.y : b.y - a.y;
  return dx > dy ? dx : dy;
};

function levelOf(e: EntityState | undefined): number {
  const s = e?.components.stats;
  return isStatsComponent(s) ? s.level : 1;
}

function maxManaFor(level: number): number {
  return 100 + 4 * (level > CHOOSE_LEVEL ? level - CHOOSE_LEVEL : 0);
}

function stateOf(e: EntityState | undefined): ClassState {
  const s = e?.components['classes:state'] as ClassState | undefined;
  return s && typeof s.mana === 'number'
    ? { ...s, cd: { ...s.cd } }
    : { cls: null, mana: 0, maxMana: 0, cd: {}, gcd: 0 };
}

function tell(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

function alive(e: EntityState | undefined): e is EntityState {
  const s = e?.components.stats;
  return e !== undefined && (!isStatsComponent(s) || s.hp > 0);
}

function sameWorld(a: EntityState, b: EntityState): boolean {
  return (a.world ?? OVERWORLD) === (b.world ?? OVERWORLD);
}

function hostile(e: EntityState): boolean {
  return e.kind !== 'player' && isStatsComponent(e.components.stats) && (e.components.hostile === true || e.components.monster !== undefined);
}

function choose(world: WorldAPI, id: number, args: unknown): void {
  const wanted = (args as { cls?: unknown } | undefined)?.cls;
  if (wanted !== 'warrior' && wanted !== 'ranger' && wanted !== 'mystic') return;
  const me = world.get(id);
  if (!me) return;
  const level = levelOf(me);
  if (level < CHOOSE_LEVEL) {
    tell(world, id, `You must reach level ${CHOOSE_LEVEL} before choosing a path.`, 'bad');
    return;
  }
  const state = stateOf(me);
  if (state.cls === wanted) return;
  const commit = (): void => {
    const def = CLASSES[wanted];
    const maxMana = maxManaFor(level);
    world.update(id, {
      'classes:state': { cls: wanted, mana: maxMana, maxMana, cd: {}, gcd: 0 } satisfies ClassState,
      'classes:class': wanted,
    });
    casts.delete(id);
    tell(world, id, `You walk the path of the ${def.name}. Your abilities are on Q, F, G and T.`, 'level');
  };
  if (!state.cls) {
    commit();
    return;
  }
  world.emit('character:charge', {
    entityId: id,
    gold: RESPEC_GOLD,
    then: (_w: WorldAPI, ok: boolean) => {
      if (ok) commit();
      else tell(world, id, `Changing your path costs ${RESPEC_GOLD} gold.`, 'bad');
    },
  });
}

function cast(world: WorldAPI, id: number, args: unknown): void {
  const p = args as { ability?: unknown; targetId?: unknown } | undefined;
  const me = world.get(id);
  if (!me || !alive(me) || typeof p?.ability !== 'string') return;
  const state = stateOf(me);
  const def = state.cls ? CLASSES[state.cls] : undefined;
  const ability = def?.abilities.find((a) => a.id === p.ability);
  if (!def || !ability) return;
  if (levelOf(me) < ability.level) {
    tell(world, id, `${ability.name} unlocks at level ${ability.level}.`, 'bad');
    return;
  }
  if (state.gcd > 0 || (state.cd[ability.id] ?? 0) > 0 || casts.has(id)) return;
  if (state.mana < ability.cost) {
    tell(world, id, `Not enough ${def.resource}.`, 'bad');
    return;
  }
  const targetId = typeof p.targetId === 'number' ? p.targetId : undefined;
  const problem = check(world, me, ability, targetId);
  if (problem) {
    tell(world, id, problem, 'bad');
    return;
  }
  state.mana -= ability.cost;
  state.gcd = GCD;
  if (ability.cast > 0) {
    const n = ++castSeq;
    casts.set(id, { ability, targetId, x: me.x, y: me.y, doneAt: clock + ability.cast });
    state.casting = { n, ability: ability.id, label: ability.name, ms: ability.cast * 100 };
    world.update(id, { 'classes:state': state });
    return;
  }
  if (ability.cooldown > 0) state.cd[ability.id] = ability.cooldown;
  world.update(id, { 'classes:state': state });
  resolve(world, me, ability, targetId);
}

/** Why an ability cannot go off right now, or undefined if it can. */
function check(world: WorldAPI, me: EntityState, ability: Ability, targetId: number | undefined): string | undefined {
  const e = ability.effect;
  const target = targetId === undefined ? undefined : world.get(targetId);
  const needsEnemy = e.kind === 'strike' || e.kind === 'splash' || e.kind === 'poison' || e.kind === 'mark';
  if (!needsEnemy) return undefined;
  if (!target || !alive(target) || !hostile(target)) return 'You need an enemy targeted (click one, or press Tab).';
  if (!sameWorld(me, target) || cheb(me, target) > e.range) {
    return e.range > 1 ? `Out of range — get within ${e.range} tiles.` : 'You need to be next to your target.';
  }
  return undefined;
}

function enemiesNear(world: WorldAPI, at: EntityState, radius: number): EntityState[] {
  return world.queryNear(at.x, at.y, radius, at.world).filter((e) => alive(e) && hostile(e));
}

function strike(world: WorldAPI, attackerId: number, targetId: number, power: number, range: number, extra: Record<string, unknown> = {}): void {
  world.emit('combat:strike', { attackerId, targetId, power, range, ...extra });
}

function resolve(world: WorldAPI, me: EntityState, ability: Ability, targetId: number | undefined): void {
  const e = ability.effect;
  const target = targetId === undefined ? undefined : world.get(targetId);
  switch (e.kind) {
    case 'strike': {
      if (!target || !alive(target) || !sameWorld(me, target) || cheb(me, target) > e.range) return;
      let power = e.power;
      const ts = target.components.stats;
      if (e.executeBelow && isStatsComponent(ts) && ts.hp / ts.maxHp < e.executeBelow) power *= 2;
      strike(world, me.id, target.id, power, e.range, { pierce: e.pierce, element: e.element });
      return;
    }
    case 'cleave':
      for (const foe of enemiesNear(world, me, e.radius)) strike(world, me.id, foe.id, e.power, e.radius, { element: e.element });
      return;
    case 'splash': {
      if (!target || !sameWorld(me, target) || cheb(me, target) > e.range) return;
      for (const foe of enemiesNear(world, target, e.radius)) {
        if (cheb(me, foe) <= e.range + e.radius) strike(world, me.id, foe.id, e.power, e.range + e.radius);
      }
      return;
    }
    case 'poison':
      if (!target || !sameWorld(me, target) || cheb(me, target) > e.range) return;
      strike(world, me.id, target.id, e.power, e.range);
      poisons.push({ casterId: me.id, targetId: target.id, power: e.dot, left: e.ticks });
      return;
    case 'heal': {
      const ally = e.ally && target?.kind === 'player' && sameWorld(me, target) && cheb(me, target) <= 6 ? target : me;
      const ms = me.components.stats;
      const amount = isStatsComponent(ms) ? floor(ms.maxHp * e.fraction) : 0;
      const as = ally.components.stats;
      const scaled = ally.id === me.id || !isStatsComponent(as) ? amount : floor(as.maxHp * e.fraction);
      world.emit('character:heal', { entityId: ally.id, amount: scaled });
      if (ally.id !== me.id) tell(world, ally.id, `${nameOf(me)} mends your wounds.`, 'good');
      return;
    }
    case 'guard': {
      const ally = e.ally && target?.kind === 'player' && sameWorld(me, target) && cheb(me, target) <= 6 ? target : me;
      world.emit('combat:modifier', { entityId: ally.id, taken: e.taken, ticks: e.ticks });
      tell(world, ally.id, `${ability.name} surrounds you.`, 'good');
      return;
    }
    case 'mark':
      if (!target || !sameWorld(me, target) || cheb(me, target) > e.range) return;
      world.emit('combat:modifier', { entityId: target.id, taken: e.taken, ticks: e.ticks });
      tell(world, me.id, `${ability.name} on ${(target.components.name as string | undefined) ?? 'your target'}.`, 'info');
      return;
  }
}

function nameOf(e: EntityState): string {
  const c = e.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : 'Someone';
}

function tickCasts(world: WorldAPI): void {
  for (const [id, c] of [...casts]) {
    const me = world.get(id);
    if (!me || !alive(me) || me.x !== c.x || me.y !== c.y) {
      casts.delete(id);
      if (me) {
        const state = stateOf(me);
        state.mana = state.mana + c.ability.cost > state.maxMana ? state.maxMana : state.mana + c.ability.cost;
        delete state.casting;
        world.update(id, { 'classes:state': state });
        tell(world, id, `${c.ability.name} interrupted.`, 'bad');
      }
      continue;
    }
    if (clock < c.doneAt) continue;
    casts.delete(id);
    const state = stateOf(me);
    delete state.casting;
    if (c.ability.cooldown > 0) state.cd[c.ability.id] = c.ability.cooldown;
    world.update(id, { 'classes:state': state });
    resolve(world, me, c.ability, c.targetId);
  }
}

function tickPools(world: WorldAPI): void {
  for (const p of world.query('classes:state')) {
    const state = stateOf(p);
    if (!state.cls) continue;
    let changed = false;
    const maxMana = maxManaFor(levelOf(p));
    if (maxMana !== state.maxMana) {
      state.maxMana = maxMana;
      changed = true;
    }
    if (state.gcd > 0) {
      state.gcd -= 1;
      changed = true;
    }
    for (const [k, v] of Object.entries(state.cd)) {
      if (v <= 1) delete state.cd[k];
      else state.cd[k] = v - 1;
      changed = true;
    }
    if (clock % REGEN_EVERY === 0 && state.mana < state.maxMana) {
      state.mana = state.mana + REGEN > state.maxMana ? state.maxMana : state.mana + REGEN;
      changed = true;
    }
    if (changed) world.update(p.id, { 'classes:state': state });
  }
}

function tickPoisons(world: WorldAPI): void {
  if (clock % 10 !== 0) return;
  for (let i = poisons.length - 1; i >= 0; i--) {
    const p = poisons[i];
    const target = world.get(p.targetId);
    if (!target || !alive(target) || !world.get(p.casterId)) {
      poisons.splice(i, 1);
      continue;
    }
    strike(world, p.casterId, p.targetId, p.power, 64, { pierce: 1, element: 'poison' });
    p.left -= 1;
    if (p.left <= 0) poisons.splice(i, 1);
  }
}

const isClassId = (v: unknown): v is ClassId => typeof v === 'string' && Object.hasOwn(CLASSES, v);

/** A path picked at creation applies at once; otherwise the saved one comes back. */
function enter(world: WorldAPI, p: Partial<PlayerEnterEvent>): void {
  if (typeof p.entityId !== 'number') return;
  const me = world.get(p.entityId);
  if (!me) return;
  const picked = p.created ? p.traits?.classes : me.components['classes:class'];
  const cls = isClassId(picked) ? picked : null;
  const maxMana = cls ? maxManaFor(levelOf(me)) : 0;
  world.update(me.id, {
    'classes:state': { cls, mana: maxMana, maxMana, cd: {}, gcd: 0 } satisfies ClassState,
    ...(cls ? { 'classes:class': cls } : {}),
  });
}

export default definePlugin({
  id: 'classes',
  items: [],
  recipes: [],
  entityKinds: [],
  privateComponents: ['classes:state'],
  persistComponents: ['classes:class'],

  systems: [
    {
      name: 'classes:tick',
      fn: (world) => {
        clock++;
        tickCasts(world);
        tickPools(world);
        tickPoisons(world);
      },
    },
  ],

  commands: [
    { name: 'classes:choose', fn: (world, args, id) => choose(world, id, args) },
    { name: 'classes:cast', fn: (world, args, id) => cast(world, id, args) },
  ],

  events: {
    'player:enter': (world, payload) => enter(world, payload as Partial<PlayerEnterEvent>),
  },
});
