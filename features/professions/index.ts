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
 * Gathering professions: mining and woodcutting. Ore veins crop out of the
 * hillsides, rare trees grow in the deep woods, and the ordinary trees of
 * the nature feature give pine. Click one with the right tool in your pack
 * and you work it: a few seconds per swing, repeating until the node is
 * spent, your pack is full, or you move. Each skill levels from 1 to 50;
 * richer nodes need a higher level and pay more experience.
 *
 * What comes out feeds crafting: the forge and the sawbench in the village
 * turn ore and logs into bars and planks, and those into weapons, armour
 * and charms that the character feature can equip (through ItemDef.equip).
 */

export type Skill = 'mining' | 'woodcutting';

export interface SkillState {
  level: number;
  xp: number;
  prev: number;
  next: number;
}

export type Skills = Record<Skill, SkillState>;

/** The player's current swing, for the cast bar. */
export interface Work {
  n: number;
  label: string;
  ms: number;
  /** What is being worked, for the chips and sparks other players see. */
  target?: number;
  skill?: Skill;
}

interface Resource {
  id: string;
  skill: Skill;
  name: string;
  item: string;
  level: number;
  xp: number;
  /** Ticks per swing before skill shaves it down. */
  ticks: number;
  charges: [number, number];
  regrow: number;
  tint: number;
}

const RESOURCES: Record<string, Resource> = {
  copper: { id: 'copper', skill: 'mining', name: 'Copper Vein', item: 'professions:copper_ore', level: 1, xp: 14, ticks: 30, charges: [3, 5], regrow: 600, tint: 0xd8894a },
  iron: { id: 'iron', skill: 'mining', name: 'Iron Vein', item: 'professions:iron_ore', level: 10, xp: 30, ticks: 36, charges: [3, 4], regrow: 900, tint: 0xb7c0ca },
  mithril: { id: 'mithril', skill: 'mining', name: 'Mithril Vein', item: 'professions:mithril_ore', level: 20, xp: 55, ticks: 42, charges: [2, 4], regrow: 1500, tint: 0x8fe3ff },
  pine: { id: 'pine', skill: 'woodcutting', name: 'Tree', item: 'professions:pine_log', level: 1, xp: 12, ticks: 28, charges: [2, 4], regrow: 600, tint: 0xffffff },
  oak: { id: 'oak', skill: 'woodcutting', name: 'Elder Oak', item: 'professions:oak_log', level: 10, xp: 28, ticks: 34, charges: [3, 5], regrow: 900, tint: 0xe8c48a },
  ironwood: { id: 'ironwood', skill: 'woodcutting', name: 'Ironwood', item: 'professions:ironwood_log', level: 20, xp: 50, ticks: 40, charges: [3, 4], regrow: 1500, tint: 0x9fb3c8 },
};

const TOOL: Record<Skill, { item: string; name: string }> = {
  mining: { item: 'professions:pickaxe', name: 'pickaxe' },
  woodcutting: { item: 'professions:hatchet', name: 'hatchet' },
};

const MAX_LEVEL = 50;

export const ITEMS: ItemDef[] = [
  { id: 'professions:pickaxe', name: 'Pickaxe', tags: ['tool', 'merchandise'], stack: 1, value: 8, icon: '⛏️', description: 'For working ore veins. Keep it in your pack.' },
  { id: 'professions:hatchet', name: 'Hatchet', tags: ['tool', 'merchandise'], stack: 1, value: 8, icon: '🪓', description: 'For felling trees. Keep it in your pack.' },

  { id: 'professions:copper_ore', name: 'Copper Ore', tags: ['ore', 'material'], stack: 30, value: 3, icon: '🟠', description: 'Green-streaked and soft. Smelt it at the forge.' },
  { id: 'professions:iron_ore', name: 'Iron Ore', tags: ['ore', 'material'], stack: 30, value: 7, icon: '⚫', description: 'Heavy and rust-red. Smelt it at the forge.' },
  { id: 'professions:mithril_ore', name: 'Mithril Ore', tags: ['ore', 'material'], stack: 30, value: 16, icon: '🔷', description: 'Light as tin, hard as anything.' },
  { id: 'professions:pine_log', name: 'Pine Log', tags: ['wood', 'material'], stack: 30, value: 2, icon: '🪵', description: 'Sappy and straight. Saw it into planks.' },
  { id: 'professions:oak_log', name: 'Elder Oak Log', tags: ['wood', 'material'], stack: 30, value: 6, icon: '🪵', description: 'Dense old heartwood.' },
  { id: 'professions:ironwood_log', name: 'Ironwood Log', tags: ['wood', 'material'], stack: 30, value: 14, icon: '🪵', description: 'Blunts axes. Worth it.' },

  { id: 'professions:copper_bar', name: 'Copper Bar', tags: ['bar', 'material'], stack: 20, value: 8, icon: '🟧', description: 'Smelted copper, ready for the anvil.' },
  { id: 'professions:iron_bar', name: 'Iron Bar', tags: ['bar', 'material'], stack: 20, value: 18, icon: '⬛', description: 'Smelted iron, ready for the anvil.' },
  { id: 'professions:mithril_bar', name: 'Mithril Bar', tags: ['bar', 'material'], stack: 20, value: 40, icon: '🟦', description: 'It hums when struck.' },
  { id: 'professions:pine_plank', name: 'Pine Plank', tags: ['plank', 'material'], stack: 30, value: 2, icon: '🟫', description: 'Rough-sawn pine.' },
  { id: 'professions:oak_plank', name: 'Oak Plank', tags: ['plank', 'material'], stack: 30, value: 7, icon: '🟫', description: 'Close-grained and strong.' },
  { id: 'professions:ironwood_plank', name: 'Ironwood Plank', tags: ['plank', 'material'], stack: 30, value: 16, icon: '🟫', description: 'Dark, dense and nearly unbreakable.' },

  { id: 'professions:copper_sword', name: 'Copper Sword', tags: ['weapon', 'equipment', 'crafted'], stack: 1, value: 45, use: 'character:use', useLabel: 'Equip', icon: '🗡️', description: 'Smith-made, soft-edged. +7 attack.', equip: { slot: 'weapon', atk: 7 } },
  { id: 'professions:iron_longsword', name: 'Iron Longsword', tags: ['weapon', 'equipment', 'crafted'], stack: 1, value: 130, use: 'character:use', useLabel: 'Equip', icon: '⚔️', description: 'A proper blade. +14 attack.', equip: { slot: 'weapon', atk: 14 } },
  { id: 'professions:mithril_blade', name: 'Mithril Blade', tags: ['weapon', 'equipment', 'crafted'], stack: 1, value: 360, use: 'character:use', useLabel: 'Equip', icon: '🔪', description: 'Weighs nothing; cuts everything. +24 attack, +10 health.', equip: { slot: 'weapon', atk: 24, hp: 10 } },
  { id: 'professions:copper_mail', name: 'Copper Scale', tags: ['armor', 'equipment', 'crafted'], stack: 1, value: 55, use: 'character:use', useLabel: 'Equip', icon: '🦺', description: 'Overlapping copper scales. +5 defense.', equip: { slot: 'armor', def: 5 } },
  { id: 'professions:iron_plate', name: 'Iron Plate', tags: ['armor', 'equipment', 'crafted'], stack: 1, value: 160, use: 'character:use', useLabel: 'Equip', icon: '🛡️', description: 'Heavy, honest protection. +10 defense, +15 health.', equip: { slot: 'armor', def: 10, hp: 15 } },
  { id: 'professions:mithril_plate', name: 'Mithril Plate', tags: ['armor', 'equipment', 'crafted'], stack: 1, value: 420, use: 'character:use', useLabel: 'Equip', icon: '🛡️', description: 'Bright as a lake at dawn. +16 defense, +35 health.', equip: { slot: 'armor', def: 16, hp: 35 } },
  { id: 'professions:oak_totem', name: 'Oaken Totem', tags: ['charm', 'equipment', 'crafted'], stack: 1, value: 60, use: 'character:use', useLabel: 'Equip', icon: '🪆', description: 'Carved with patient hands. +25 health.', equip: { slot: 'charm', hp: 25 } },
  { id: 'professions:ironwood_ward', name: 'Ironwood Ward', tags: ['charm', 'equipment', 'crafted'], stack: 1, value: 220, use: 'character:use', useLabel: 'Equip', icon: '🧿', description: 'Turns blows aside. +4 defense, +40 health.', equip: { slot: 'charm', def: 4, hp: 40 } },
];

const FORGE = 'professions:forge';
const SAWBENCH = 'professions:sawbench';

const recipe = (
  id: string,
  station: string,
  inputs: [string, number][],
  count: number,
  ticks: number,
): RecipeDef => ({
  id,
  station,
  inputs: inputs.map(([item, n]) => ({ id: item, count: n })),
  outputs: [{ id, count }],
  ticks,
});

export const RECIPES: RecipeDef[] = [
  recipe('professions:copper_bar', FORGE, [['professions:copper_ore', 2]], 1, 20),
  recipe('professions:iron_bar', FORGE, [['professions:iron_ore', 2], ['professions:pine_log', 1]], 1, 30),
  recipe('professions:mithril_bar', FORGE, [['professions:mithril_ore', 2], ['professions:oak_log', 1]], 1, 40),
  recipe('professions:copper_sword', FORGE, [['professions:copper_bar', 3], ['professions:pine_plank', 1]], 1, 40),
  recipe('professions:copper_mail', FORGE, [['professions:copper_bar', 4]], 1, 40),
  recipe('professions:iron_longsword', FORGE, [['professions:iron_bar', 3], ['professions:oak_plank', 1]], 1, 50),
  recipe('professions:iron_plate', FORGE, [['professions:iron_bar', 5]], 1, 55),
  recipe('professions:mithril_blade', FORGE, [['professions:mithril_bar', 3], ['professions:ironwood_plank', 1]], 1, 70),
  recipe('professions:mithril_plate', FORGE, [['professions:mithril_bar', 5]], 1, 75),
  recipe('professions:pine_plank', SAWBENCH, [['professions:pine_log', 1]], 2, 15),
  recipe('professions:oak_plank', SAWBENCH, [['professions:oak_log', 1]], 2, 20),
  recipe('professions:ironwood_plank', SAWBENCH, [['professions:ironwood_log', 1]], 2, 25),
  recipe('professions:oak_totem', SAWBENCH, [['professions:oak_plank', 4], ['professions:copper_bar', 1]], 1, 45),
  recipe('professions:ironwood_ward', SAWBENCH, [['professions:ironwood_plank', 4], ['professions:iron_bar', 1]], 1, 60),
];

/** Total experience to reach a level. */
export function xpFor(level: number): number {
  return 20 * (level - 1) * level;
}

function levelFor(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpFor(level + 1)) level++;
  return level;
}

function skillState(xp: number): SkillState {
  const level = levelFor(xp);
  return { level, xp, prev: xpFor(level), next: xpFor(level < MAX_LEVEL ? level + 1 : level) };
}

const freshSkills = (): Skills => ({ mining: skillState(0), woodcutting: skillState(0) });

interface NodeComponent {
  resource: string;
  charges: number;
  /** Ticks left until a spent node is workable again; 0 while it has charges. */
  regrowIn: number;
}

interface Gathering {
  targetId: number;
  resource: Resource;
  x: number;
  y: number;
  doneAt: number;
  n: number;
}

let clock = 0;
let workSeq = 0;
const gathering = new Map<number, Gathering>();
/** Ordinary trees belong to the nature feature, so their felling is tracked here, not on them. */
/** Swings left in each ordinary tree being worked; a tree with none left is felled. */
const pineCharges = new Map<number, number>();

/** A felled tree: a stump until `sapling`, a sapling until `grown` (epoch ms, so it survives restarts). */
interface Felled {
  sapling: number;
  grown: number;
}

const FELLED = 'professions:felled';
const STUMP_MS = 90_000;
const SAPLING_MS = 90_000;

const floor = (n: number): number => n | 0;
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const dx = a.x > b.x ? a.x - b.x : b.x - a.x;
  const dy = a.y > b.y ? a.y - b.y : b.y - a.y;
  return dx > dy ? dx : dy;
};

function skillsOf(e: EntityState | undefined): Skills {
  const s = e?.components['professions:skills'] as Skills | undefined;
  return s && s.mining && s.woodcutting ? s : freshSkills();
}

function inventoryOf(e: EntityState | undefined): InventoryComponent | undefined {
  const inv = e?.components.inventory as InventoryComponent | undefined;
  return inv && Array.isArray(inv.slots) ? inv : undefined;
}

function has(e: EntityState | undefined, itemId: string): boolean {
  return inventoryOf(e)?.slots.some((s) => s.itemId === itemId && s.count > 0) ?? false;
}

function tell(world: WorldAPI, id: number, text: string, tone = 'info'): void {
  world.emit('character:grant', { entityId: id, reason: text, tone });
}

function nodeOf(e: EntityState | undefined): NodeComponent | undefined {
  const n = e?.components['professions:node'] as NodeComponent | undefined;
  return n && typeof n.resource === 'string' ? n : undefined;
}

/** What a target yields, and whether it has anything left. */
function resourceAt(target: EntityState): { resource: Resource; ready: boolean } | undefined {
  if (target.kind === 'nature:tree') {
    return { resource: RESOURCES.pine, ready: target.components[FELLED] === undefined };
  }
  const node = nodeOf(target);
  const resource = node ? RESOURCES[node.resource] : undefined;
  return node && resource ? { resource, ready: node.charges > 0 } : undefined;
}

function swingTicks(resource: Resource, level: number): number {
  const faster = floor((level - resource.level) / 2);
  const ticks = resource.ticks - (faster > 0 ? faster : 0);
  return ticks < 12 ? 12 : ticks;
}

function startGathering(world: WorldAPI, playerId: number, args: unknown): void {
  const targetId = (args as { targetId?: unknown } | undefined)?.targetId;
  const me = world.get(playerId);
  const target = typeof targetId === 'number' ? world.get(targetId) : undefined;
  if (!me || !target || (me.world ?? OVERWORLD) !== (target.world ?? OVERWORLD) || cheb(me, target) > 1) return;
  const found = resourceAt(target);
  if (!found) return;
  const { resource, ready } = found;
  const skills = skillsOf(me);
  const skill = skills[resource.skill];
  const verb = resource.skill === 'mining' ? 'mine' : 'cut';
  if (!has(me, TOOL[resource.skill].item)) {
    tell(world, playerId, `You need a ${TOOL[resource.skill].name} to ${verb} this. The trader sells them.`, 'bad');
    return;
  }
  if (skill.level < resource.level) {
    tell(world, playerId, `You need ${resource.skill} level ${resource.level} to ${verb} ${resource.name.toLowerCase()}.`, 'bad');
    return;
  }
  if (!ready) {
    tell(world, playerId, resource.skill === 'mining' ? 'This vein is spent. It will come back in time.' : 'This tree has been felled for now.', 'info');
    return;
  }
  begin(world, me, target, resource, skill.level);
}

function begin(world: WorldAPI, me: EntityState, target: EntityState, resource: Resource, level: number): void {
  const ticks = swingTicks(resource, level);
  const n = ++workSeq;
  gathering.set(me.id, { targetId: target.id, resource, x: me.x, y: me.y, doneAt: clock + ticks, n });
  world.update(me.id, {
    'professions:work': {
      n,
      label: `${resource.skill === 'mining' ? 'Mining' : 'Chopping'} ${resource.name}`,
      ms: ticks * 100,
      target: target.id,
      skill: resource.skill,
    } satisfies Work,
  });
}

function stop(world: WorldAPI, id: number): void {
  if (!gathering.delete(id)) return;
  world.update(id, { 'professions:work': undefined });
}

function award(world: WorldAPI, me: EntityState, resource: Resource): void {
  const skills = skillsOf(me);
  const before = skills[resource.skill];
  const after = skillState(before.xp + resource.xp);
  const next = { ...skills, [resource.skill]: after };
  world.update(me.id, { 'professions:skills': next });
  if (after.level > before.level) {
    const title = resource.skill === 'mining' ? 'Mining' : 'Woodcutting';
    tell(world, me.id, `${title} level ${after.level}!${unlockNote(resource.skill, after.level)}`, 'level');
  }
}

function unlockNote(skill: Skill, level: number): string {
  const unlocked = Object.values(RESOURCES).filter((r) => r.skill === skill && r.level === level);
  return unlocked.length ? ` You can now work ${unlocked.map((r) => r.name).join(', ')}.` : '';
}

function spend(world: WorldAPI, target: EntityState, resource: Resource): boolean {
  if (target.kind === 'nature:tree') {
    const charges = (pineCharges.get(target.id) ?? between(world, resource.charges)) - 1;
    if (charges > 0) {
      pineCharges.set(target.id, charges);
      return true;
    }
    pineCharges.delete(target.id);
    const now = Date.now();
    world.update(target.id, {
      [FELLED]: { sapling: now + STUMP_MS, grown: now + STUMP_MS + SAPLING_MS } satisfies Felled,
      appearance: { frame: 'objects/tree-stump', scale: 1.5 },
    });
    return false;
  }
  const node = nodeOf(target);
  if (!node) return false;
  const charges = node.charges - 1;
  world.update(target.id, {
    'professions:node': { ...node, charges, regrowIn: charges > 0 ? 0 : resource.regrow },
    ...(charges > 0 ? {} : nodeLook(resource, false)),
  });
  return charges > 0;
}

function between(world: WorldAPI, [lo, hi]: [number, number]): number {
  return lo + floor(world.rng() * (hi - lo + 1));
}

function tickGathering(world: WorldAPI): void {
  for (const [id, g] of [...gathering]) {
    const me = world.get(id);
    const target = world.get(g.targetId);
    const stats = me?.components.stats;
    if (!me || !target || me.x !== g.x || me.y !== g.y || (isStatsComponent(stats) && stats.hp <= 0)) {
      stop(world, id);
      continue;
    }
    if (clock < g.doneAt) continue;
    const left = world.give(id, g.resource.item, 1);
    if (left > 0) {
      tell(world, id, 'Your pack is full.', 'bad');
      stop(world, id);
      continue;
    }
    award(world, me, g.resource);
    const more = spend(world, target, g.resource);
    if (!more) {
      tell(world, id, g.resource.skill === 'mining' ? 'The vein is exhausted.' : 'The tree comes down.', 'info');
      stop(world, id);
      continue;
    }
    const now = world.get(id) ?? me;
    begin(world, now, target, g.resource, skillsOf(now)[g.resource.skill].level);
  }
}

function nodeLook(resource: Resource, ready: boolean): Record<string, unknown> {
  const mining = resource.skill === 'mining';
  const frame = mining ? 'objects/small-rock' : ready ? 'objects/tree' : 'objects/tree-stump';
  const scale = mining || !ready ? 1.5 : 1;
  return {
    label: ready ? resource.name : `${resource.name} (spent)`,
    appearance: { frame, scale, tint: ready ? resource.tint : mining ? 0x55504a : 0xffffff },
  };
}

function gatherVerb(resource: Resource): { intent: string; label: string } {
  return { intent: 'professions:gather', label: resource.skill === 'mining' ? 'Mine' : 'Chop' };
}

function spawnNode(world: WorldAPI, resource: Resource, x: number, y: number): number {
  return world.spawn('professions:node', { x, y }, {
    'professions:node': { resource: resource.id, charges: between(world, resource.charges), regrowIn: 0 } satisfies NodeComponent,
    interact: gatherVerb(resource),
    ...nodeLook(resource, true),
  });
}

function regrow(world: WorldAPI, step: number): void {
  for (const e of world.query('professions:node')) {
    const node = nodeOf(e);
    const resource = node ? RESOURCES[node.resource] : undefined;
    if (!node || !resource || node.charges > 0) continue;
    const regrowIn = node.regrowIn - step;
    if (regrowIn > 0) {
      world.update(e.id, { 'professions:node': { ...node, regrowIn } });
      continue;
    }
    world.update(e.id, {
      'professions:node': { ...node, charges: between(world, resource.charges), regrowIn: 0 },
      ...nodeLook(resource, true),
    });
  }
  const now = Date.now();
  for (const tree of world.query(FELLED)) {
    const felled = tree.components[FELLED] as Felled;
    if (now >= felled.grown) {
      world.update(tree.id, { [FELLED]: undefined, appearance: undefined });
    } else if (now >= felled.sapling && (tree.components.appearance as { frame?: string } | undefined)?.frame !== 'objects/tree') {
      world.update(tree.id, { appearance: { frame: 'objects/tree', scale: 0.5 } });
    }
  }
  for (const id of pineCharges.keys()) if (!world.get(id)) pineCharges.delete(id);
}

/** Which ore or timber a spot offers: richer further from the village. */
function pick(skill: Skill, x: number, y: number, rng: () => number): Resource {
  const d = cheb({ x, y }, { x: WORLD_CENTER_X, y: WORLD_CENTER_Y });
  const roll = rng();
  if (skill === 'mining') {
    if (d > 220 && roll < 0.45) return RESOURCES.mithril;
    if (d > 90 && roll < 0.6) return RESOURCES.iron;
    return RESOURCES.copper;
  }
  if (d > 200 && roll < 0.5) return RESOURCES.ironwood;
  return RESOURCES.oak;
}

const hilly = (world: WorldAPI, x: number, y: number): boolean =>
  [world.tile(x + 1, y), world.tile(x - 1, y), world.tile(x, y + 1), world.tile(x, y - 1)].includes('mountain');

/** First run: a few nodes and the two workstations within reach of the village. */
function settle(world: WorldAPI): void {
  if (world.getSet('professions:village-v1', '1')) return;
  const cx = WORLD_CENTER_X;
  const cy = WORLD_CENTER_Y;
  const free = (x: number, y: number): boolean => world.walkable(x, y) && world.queryNear(x, y, 1).length === 0;
  const stations: [string, number, number, string][] = [
    [FORGE, cx - 6, cy + 3, 'Forge'],
    [SAWBENCH, cx + 6, cy + 3, 'Sawbench'],
  ];
  for (const [kind, x0, y0, label] of stations) {
    let placed = false;
    for (let r = 0; r < 6 && !placed; r++) {
      for (let dy = -r; dy <= r && !placed; dy++) {
        for (let dx = -r; dx <= r && !placed; dx++) {
          if (!free(x0 + dx, y0 + dy)) continue;
          world.spawn(kind, { x: x0 + dx, y: y0 + dy }, { label });
          placed = true;
        }
      }
    }
  }
  let rng = 12345;
  const next = (): number => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng / 4294967296;
  };
  const want: [Resource, number][] = [
    [RESOURCES.copper, 5],
    [RESOURCES.oak, 3],
    [RESOURCES.iron, 2],
  ];
  for (const [resource, count] of want) {
    let made = 0;
    for (let attempt = 0; attempt < 400 && made < count; attempt++) {
      const near = resource === RESOURCES.iron ? 55 : 28;
      const reach = near + 18;
      const x = cx + floor((next() * 2 - 1) * reach);
      const y = cy + floor((next() * 2 - 1) * reach);
      const d = cheb({ x, y }, { x: cx, y: cy });
      if (d < near || d > reach) continue;
      const tile = world.tile(x, y);
      if (tile !== 'grass' && tile !== 'dirt' && tile !== 'forest') continue;
      if (!free(x, y) || (resource.skill === 'mining' && attempt < 300 && !hilly(world, x, y))) continue;
      spawnNode(world, resource, x, y);
      made++;
    }
  }
}

export default definePlugin({
  id: 'professions',
  items: ITEMS,
  recipes: RECIPES,
  entityKinds: ['professions:node', FORGE, SAWBENCH],

  systems: [
    {
      name: 'professions:tick',
      fn: (world) => {
        clock++;
        if (clock === 8) settle(world);
        if (clock === 9) {
          for (const e of world.query('professions:node')) {
            const resource = RESOURCES[nodeOf(e)?.resource ?? ''];
            if (resource && e.components.interact === undefined) {
              world.update(e.id, { interact: gatherVerb(resource) });
            }
          }
        }
        tickGathering(world);
        if (clock % 50 === 0) regrow(world, 50);
      },
    },
  ],

  commands: [
    { name: 'professions:gather', fn: (world, args, id) => startGathering(world, id, args) },
    { name: 'professions:stop', fn: (world, _args, id) => stop(world, id) },
  ],

  persistComponents: ['professions:skills'],

  events: {
    'entity:damage': (world, payload) => {
      const targetId = (payload as { targetId?: unknown }).targetId;
      if (typeof targetId === 'number' && gathering.has(targetId)) {
        tell(world, targetId, 'You are interrupted!', 'bad');
        stop(world, targetId);
      }
    },
  },

  decorateChunk: (world, area, rng) => {
    const midX = (area.minX + area.maxX) >> 1;
    const midY = (area.minY + area.maxY) >> 1;
    if (cheb({ x: midX, y: midY }, { x: WORLD_CENTER_X, y: WORLD_CENTER_Y }) < 40) return;
    let veins = 0;
    let trees = 0;
    for (let attempt = 0; attempt < 60 && (veins < 2 || trees < 1); attempt++) {
      const x = area.minX + 2 + floor(rng() * (area.maxX - area.minX - 4));
      const y = area.minY + 2 + floor(rng() * (area.maxY - area.minY - 4));
      const tile = world.tile(x, y);
      if (!world.walkable(x, y)) continue;
      if (veins < 2 && tile !== 'water' && hilly(world, x, y) && rng() < 0.55) {
        spawnNode(world, pick('mining', x, y, rng), x, y);
        veins++;
      } else if (trees < 1 && tile === 'forest' && rng() < 0.18) {
        spawnNode(world, pick('woodcutting', x, y, rng), x, y);
        trees++;
      }
    }
  },
});
