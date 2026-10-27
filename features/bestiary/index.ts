import {
  definePlugin,
  isStatsComponent,
  OVERWORLD,
  WORLD_CENTER_X,
  WORLD_CENTER_Y,
  type Direction,
  type EntityState,
  type ItemDef,
  type MovementComponent,
  type NPCComponent,
  type WorldAPI,
} from '@game/shared';

/**
 * The wild: hostile creatures that roam outside the village, scale with
 * distance and with the world they live in, hunt players who wander close,
 * and drop pelts, fangs and coin when they fall.
 *
 * Monsters are ordinary NPCs — this feature registers a 'bestiary:hunter'
 * behaviour through the npc feature's 'npc:register-ais' extension point,
 * and the npc system moves them and announces their swings. Rewards go out
 * through 'character:grant'; the loot itself is handed over with
 * world.give, or left on the ground when the killer's pack is full.
 */

interface Species {
  id: string;
  name: string;
  title: string;
  creature: 'dog' | 'sheep' | 'chicken';
  tint: number;
  scale?: number;
  level: number;
  hp: number;
  atk: number;
  def: number;
  speed: number;
  aggro: number;
  xp: number;
  gold: [number, number];
  loot: [string, number][];
  worlds: string[];
  /** Rare elite variant: bigger, tougher, better loot. */
  elite?: boolean;
}

const SPECIES: Species[] = [
  { id: 'hen', name: 'Feral Hen', title: 'Fowl', creature: 'chicken', tint: 0xf0d9a8, level: 1, hp: 22, atk: 7, def: 0, speed: 0.34, aggro: 3, xp: 9, gold: [0, 3], loot: [['bestiary:feather', 0.7]], worlds: [OVERWORLD] },
  { id: 'wolf', name: 'Grey Wolf', title: 'Beast', creature: 'dog', tint: 0xa7adbb, level: 2, hp: 45, atk: 10, def: 2, speed: 0.34, aggro: 4, xp: 20, gold: [2, 6], loot: [['bestiary:wolf_pelt', 0.55], ['bestiary:fang', 0.25]], worlds: [OVERWORLD] },
  { id: 'ram', name: 'Wild Ram', title: 'Beast', creature: 'sheep', tint: 0xd8c7a0, level: 3, hp: 75, atk: 14, def: 5, speed: 0.25, aggro: 4, xp: 32, gold: [3, 9], loot: [['bestiary:ram_horn', 0.5], ['bestiary:wool', 0.6]], worlds: [OVERWORLD] },
  { id: 'hound', name: 'Rabid Hound', title: 'Beast', creature: 'dog', tint: 0xc9725a, level: 4, hp: 80, atk: 18, def: 4, speed: 0.4, aggro: 6, xp: 46, gold: [4, 12], loot: [['bestiary:fang', 0.5], ['character:minor_draught', 0.15]], worlds: [OVERWORLD] },
  { id: 'cockatrice', name: 'Cockatrice', title: 'Monstrosity', creature: 'chicken', tint: 0x8fcf6b, scale: 1.25, level: 5, hp: 90, atk: 24, def: 4, speed: 0.34, aggro: 5, xp: 62, gold: [6, 15], loot: [['bestiary:feather', 0.8], ['bestiary:venom_gland', 0.35]], worlds: [OVERWORLD, 'verdant'] },
  { id: 'alpha', name: 'Alpha Wolf', title: 'Elite Beast', creature: 'dog', tint: 0x6f7787, scale: 1.4, level: 6, hp: 220, atk: 26, def: 9, speed: 0.4, aggro: 7, xp: 150, gold: [20, 45], loot: [['bestiary:wolf_pelt', 1], ['character:wolf_tooth_charm', 0.3], ['character:draught', 0.4]], worlds: [OVERWORLD], elite: true },
  { id: 'ember', name: 'Ember Hound', title: 'Fire Beast', creature: 'dog', tint: 0xff7a3a, level: 7, hp: 150, atk: 30, def: 9, speed: 0.4, aggro: 7, xp: 110, gold: [10, 25], loot: [['bestiary:ember_fang', 0.5], ['character:draught', 0.15]], worlds: ['fire'] },
  { id: 'cinder_ram', name: 'Cinder Ram', title: 'Fire Beast', creature: 'sheep', tint: 0x9a5a45, scale: 1.2, level: 8, hp: 210, atk: 32, def: 14, speed: 0.25, aggro: 5, xp: 140, gold: [12, 30], loot: [['bestiary:ram_horn', 0.6], ['character:ember_charm', 0.05]], worlds: ['fire'] },
  { id: 'frost_wolf', name: 'Frost Wolf', title: 'Ice Beast', creature: 'dog', tint: 0xc4e6ff, level: 6, hp: 130, atk: 26, def: 8, speed: 0.4, aggro: 7, xp: 95, gold: [8, 20], loot: [['bestiary:frost_pelt', 0.5]], worlds: ['snow'] },
  { id: 'yeti_ram', name: 'Snowhorn', title: 'Ice Beast', creature: 'sheep', tint: 0xffffff, scale: 1.45, level: 9, hp: 300, atk: 34, def: 16, speed: 0.25, aggro: 5, xp: 190, gold: [15, 40], loot: [['bestiary:frost_pelt', 0.8], ['character:scale_hauberk', 0.04]], worlds: ['snow'], elite: true },
  { id: 'drowned_hen', name: 'Drowned Hen', title: 'Restless Dead', creature: 'chicken', tint: 0x6fb6ff, level: 5, hp: 95, atk: 22, def: 6, speed: 0.34, aggro: 5, xp: 70, gold: [6, 16], loot: [['bestiary:pearl', 0.25], ['bestiary:feather', 0.5]], worlds: ['water'] },
  { id: 'bog_hound', name: 'Bog Hound', title: 'Restless Dead', creature: 'dog', tint: 0x5d8a7a, level: 7, hp: 160, atk: 29, def: 10, speed: 0.4, aggro: 6, xp: 120, gold: [10, 26], loot: [['bestiary:pearl', 0.35]], worlds: ['water'] },
  { id: 'thorn_ram', name: 'Thornback Ram', title: 'Forest Beast', creature: 'sheep', tint: 0x7fb85a, scale: 1.2, level: 6, hp: 170, atk: 24, def: 12, speed: 0.25, aggro: 4, xp: 100, gold: [8, 22], loot: [['bestiary:ram_horn', 0.6], ['bestiary:wool', 0.6]], worlds: ['verdant'] },
  { id: 'moss_hound', name: 'Mossjaw', title: 'Forest Beast', creature: 'dog', tint: 0x6a9a4a, level: 8, hp: 190, atk: 31, def: 10, speed: 0.4, aggro: 7, xp: 150, gold: [12, 30], loot: [['bestiary:fang', 0.7], ['character:runed_blade', 0.03]], worlds: ['verdant'] },
];

export const LOOT: ItemDef[] = [
  { id: 'bestiary:feather', name: 'Ragged Feather', tags: ['loot', 'material'], stack: 30, value: 2, icon: '🪶', description: 'Fletchers and hatters pay for these.' },
  { id: 'bestiary:wolf_pelt', name: 'Wolf Pelt', tags: ['loot', 'material', 'hide'], stack: 20, value: 6, icon: '🐺', description: 'Thick grey fur. The trader will take it.' },
  { id: 'bestiary:fang', name: 'Sharp Fang', tags: ['loot', 'material'], stack: 30, value: 5, icon: '🦷', description: 'Still sharp enough to cut a finger.' },
  { id: 'bestiary:ram_horn', name: 'Curled Horn', tags: ['loot', 'material'], stack: 20, value: 9, icon: '🐏', description: 'Carved into cups and buttons.' },
  { id: 'bestiary:wool', name: 'Matted Wool', tags: ['loot', 'material'], stack: 30, value: 3, icon: '🧶', description: 'Needs a good wash.' },
  { id: 'bestiary:venom_gland', name: 'Venom Gland', tags: ['loot', 'alchemy'], stack: 20, value: 14, icon: '🫧', description: 'The alchemist handles these with tongs.' },
  { id: 'bestiary:ember_fang', name: 'Ember Fang', tags: ['loot', 'alchemy'], stack: 20, value: 22, icon: '🔥', description: 'It glows faintly in the dark.' },
  { id: 'bestiary:frost_pelt', name: 'Frost Pelt', tags: ['loot', 'material', 'hide'], stack: 20, value: 20, icon: '❄️', description: 'Cold to the touch, even by the fire.' },
  { id: 'bestiary:pearl', name: 'Drowned Pearl', tags: ['loot', 'treasure'], stack: 20, value: 30, icon: '🦪', description: 'Grey, lustrous and faintly sad.' },
];

export interface MonsterComponent {
  species: string;
  title: string;
  homeX: number;
  homeY: number;
}

/** Players this close to the world centre are in the village: nothing spawns there. */
const SAFE_RADIUS = 24;
const POP_EVERY = 20;
const POP_RADIUS = 22;
const POP_TARGET = 7;
const SPAWN_MIN = 12;
const SPAWN_MAX = 20;
const CULL_RADIUS = 80;
const WANDER_RADIUS = 6;
const LEASH = 14;

const abs = (n: number): number => (n < 0 ? -n : n);
const floor = (n: number): number => n | 0;
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const dx = abs(a.x - b.x);
  const dy = abs(a.y - b.y);
  return dx > dy ? dx : dy;
};

const DELTA: Record<Direction, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
};

function isMonster(value: unknown): value is MonsterComponent {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.species === 'string' && typeof m.homeX === 'number';
}

/** Overworld danger climbs with distance from the village. */
function dangerLevel(world: string, x: number, y: number): number {
  if (world !== OVERWORLD) return 99;
  const d = cheb({ x, y }, { x: WORLD_CENTER_X, y: WORLD_CENTER_Y });
  return 1 + floor((d - SAFE_RADIUS) / 16);
}

function pickSpecies(world: WorldAPI, worldId: string, x: number, y: number): Species | undefined {
  const danger = dangerLevel(worldId, x, y);
  const pool = SPECIES.filter(
    (s) => s.worlds.includes(worldId) && s.level <= danger && (!s.elite || world.rng() < 0.08),
  );
  if (pool.length === 0) return undefined;
  // Favour the toughest species the area allows, but keep the weaker ones around.
  const weights = pool.map((s) => 1 + s.level);
  let roll = world.rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function spawnMonster(world: WorldAPI, species: Species, x: number, y: number, worldId: string): number {
  return world.spawn(
    'bestiary:monster',
    { x, y },
    {
      npc: { ai: 'bestiary:hunter', state: 'wandering', lastActionTick: 0 },
      movement: { speed: species.speed, nextMoveTick: 0 },
      stats: { hp: species.hp, maxHp: species.hp, atk: species.atk, def: species.def, level: species.level },
      monster: { species: species.id, title: species.title, homeX: x, homeY: y } satisfies MonsterComponent,
      name: species.name,
      hostile: true,
      appearance: {
        creature: species.creature,
        tint: species.tint,
        scale: species.scale ?? 1.5,
        desaturate: species.creature === 'dog',
      },
    },
    worldId,
  );
}

/** Keep a handful of monsters around every player outside the village. */
function populate(world: WorldAPI): void {
  for (const p of world.query('player')) {
    const worldId = p.world ?? OVERWORLD;
    if (worldId.startsWith('interior:')) continue;
    if (worldId === OVERWORLD && cheb(p, { x: WORLD_CENTER_X, y: WORLD_CENTER_Y }) < SAFE_RADIUS - 6) continue;
    const near = world.queryNear(p.x, p.y, POP_RADIUS, worldId).filter((e) => e.kind === 'bestiary:monster');
    if (near.length >= POP_TARGET) continue;
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = world.rng();
      const dist = SPAWN_MIN + floor(world.rng() * (SPAWN_MAX - SPAWN_MIN));
      const side = floor(angle * 4);
      const along = floor(world.rng() * dist * 2) - dist;
      const x = p.x + (side === 0 ? dist : side === 1 ? -dist : along);
      const y = p.y + (side === 2 ? dist : side === 3 ? -dist : along);
      if (worldId === OVERWORLD && cheb({ x, y }, { x: WORLD_CENTER_X, y: WORLD_CENTER_Y }) < SAFE_RADIUS) continue;
      if (worldId !== OVERWORLD && cheb({ x, y }, { x: WORLD_CENTER_X, y: WORLD_CENTER_Y }) < 6) continue;
      if (!world.walkable(x, y, worldId)) continue;
      if (world.queryNear(x, y, 0, worldId).length > 0) continue;
      const species = pickSpecies(world, worldId, x, y);
      if (!species) break;
      spawnMonster(world, species, x, y, worldId);
      break;
    }
  }
}

/** Monsters nobody is near any more go back to wherever monsters go. */
function cull(world: WorldAPI): void {
  for (const m of world.query('monster')) {
    if (!world.hasPlayerNear(m.x, m.y, CULL_RADIUS, m.world)) world.despawn(m.id);
  }
}

function stepToward(world: WorldAPI, e: EntityState, tx: number, ty: number): Direction | undefined {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const horizontal: Direction | undefined = dx > 0 ? 'e' : dx < 0 ? 'w' : undefined;
  const vertical: Direction | undefined = dy > 0 ? 's' : dy < 0 ? 'n' : undefined;
  const order = abs(dx) >= abs(dy) ? [horizontal, vertical] : [vertical, horizontal];
  for (const dir of order) {
    if (!dir) continue;
    const d = DELTA[dir];
    if (world.walkable(e.x + d.x, e.y + d.y, e.world)) return dir;
  }
  // Blocked both ways: try sidestepping so a wall corner does not pin it.
  for (const dir of ['n', 'e', 's', 'w'] as Direction[]) {
    const d = DELTA[dir];
    if (world.walkable(e.x + d.x, e.y + d.y, e.world) && world.rng() < 0.5) return dir;
  }
  return undefined;
}

/**
 * The hunter: wander near home; chase a player who comes within aggro
 * range; give up (and heal) once dragged too far from home.
 */
function hunter(world: WorldAPI, entity: EntityState, nearby: EntityState[]): void {
  const npc = entity.components.npc as NPCComponent;
  const movement = entity.components.movement as MovementComponent;
  const monster = entity.components.monster;
  if (!isMonster(monster)) return;
  const species = SPECIES.find((s) => s.id === monster.species);
  const home = { x: monster.homeX, y: monster.homeY };

  if (npc.state === 'chasing') {
    const target = typeof npc.target === 'number' ? world.get(npc.target) : undefined;
    const tStats = target?.components.stats;
    const lost =
      !target ||
      (target.world ?? OVERWORLD) !== (entity.world ?? OVERWORLD) ||
      cheb(entity, home) > LEASH ||
      cheb(entity, target) > LEASH ||
      (isStatsComponent(tStats) && tStats.hp <= 0);
    if (!lost) {
      movement.dir = cheb(entity, target) <= 1 ? undefined : stepToward(world, entity, target.x, target.y);
      return;
    }
    npc.state = 'returning';
    npc.target = undefined;
  }

  if (npc.state === 'returning') {
    if (cheb(entity, home) <= 1) {
      npc.state = 'idle';
      movement.dir = undefined;
      const stats = entity.components.stats;
      if (isStatsComponent(stats)) world.update(entity.id, { stats: { ...stats, hp: stats.maxHp } });
      return;
    }
    movement.dir = stepToward(world, entity, home.x, home.y);
    return;
  }

  const aggro = species?.aggro ?? 4;
  const prey = nearby.find((e) => {
    if (e.kind !== 'player') return false;
    const s = e.components.stats;
    return cheb(entity, e) <= aggro && (!isStatsComponent(s) || s.hp > 0);
  });
  if (prey && cheb(prey, home) <= LEASH) {
    npc.state = 'chasing';
    npc.target = prey.id;
    movement.dir = stepToward(world, entity, prey.x, prey.y);
    return;
  }

  if (npc.state === 'idle') {
    movement.dir = undefined;
    if (world.rng() < 0.04) npc.state = 'wandering';
    return;
  }
  if (world.rng() < 0.05) {
    npc.state = 'idle';
    movement.dir = undefined;
    return;
  }
  if (cheb(entity, home) > WANDER_RADIUS) {
    movement.dir = stepToward(world, entity, home.x, home.y);
    return;
  }
  if (!movement.dir || world.rng() < 0.3) {
    const dirs: Direction[] = ['n', 'e', 's', 'w'];
    movement.dir = dirs[floor(world.rng() * 4)];
  }
}

function rollLoot(world: WorldAPI, species: Species): { itemId: string; count: number }[] {
  const out: { itemId: string; count: number }[] = [];
  for (const [itemId, chance] of species.loot) {
    if (world.rng() < chance) out.push({ itemId, count: 1 });
  }
  return out;
}

function itemName(world: WorldAPI, itemId: string): string {
  const own = LOOT.find((i) => i.id === itemId);
  if (own) return own.name;
  for (const tag of ['consumable', 'equipment']) {
    const def = world.queryItemsByTag(tag).find((i) => i.id === itemId);
    if (def) return def.name;
  }
  return itemId;
}

let clock = 0;

export default definePlugin({
  id: 'bestiary',
  items: LOOT,
  recipes: [],
  entityKinds: ['bestiary:monster'],

  systems: [
    {
      name: 'bestiary:population',
      fn: (world) => {
        clock++;
        if (clock % POP_EVERY === 0) populate(world);
        if (clock % 200 === 0) cull(world);
      },
    },
  ],

  commands: [],

  events: {
    'npc:register-ais': (_world, payload) => {
      const register = (payload as { register?: unknown }).register;
      if (typeof register === 'function') register('bestiary:hunter', hunter);
    },
    'combat:killed': (world, payload) => {
      const ev = payload as {
        killerId?: number;
        x?: number;
        y?: number;
        world?: string;
        components?: Record<string, unknown>;
      };
      const monster = ev.components?.monster;
      if (!isMonster(monster) || typeof ev.killerId !== 'number') return;
      const species = SPECIES.find((s) => s.id === monster.species);
      const killer = world.get(ev.killerId);
      if (!species || !killer || killer.kind !== 'player') return;

      const gold = species.gold[0] + floor(world.rng() * (species.gold[1] - species.gold[0] + 1));
      const drops = rollLoot(world, species);
      const parts: string[] = [];
      for (const drop of drops) {
        const left = world.give(killer.id, drop.itemId, drop.count);
        if (left > 0 && typeof ev.x === 'number' && typeof ev.y === 'number') {
          world.spawn('item', { x: ev.x, y: ev.y }, { itemDrop: { itemId: drop.itemId, count: left } }, ev.world);
        }
        parts.push(itemName(world, drop.itemId));
      }
      const loot = [gold > 0 ? `${gold} gold` : '', ...parts].filter(Boolean).join(', ');
      world.emit('character:grant', {
        entityId: killer.id,
        xp: species.xp,
        gold,
        reason: `${species.name} defeated · +${species.xp} XP${loot ? ` · ${loot}` : ''}`,
      });
      world.emit('bestiary:slain', { killerId: killer.id, species: species.id, name: species.name, world: ev.world });
    },
  },
});
