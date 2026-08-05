import {
  definePlugin,
  emptySlots,
  INVENTORY_CAPACITY,
  isMovementComponent,
  isNPCComponent,
  type Direction,
  type ItemDef,
} from '@game/shared';

/**
 * The tutorial feature — a copy-me skeleton. Everything registered here is
 * picked up by the server at boot; nothing outside this folder changes.
 *
 * - one entity kind:        '_example:totem'
 * - one station kind:       '_example:workbench' (Phase 6)
 * - one system:             '_example:beat', logs every tick
 * - five items:             herb / vial / stone (Phase 5), glowing_essence /
 *                           polished_stone (Phase 6, crafted outputs)
 * - two recipes:            '_example:glowing_essence' and
 *                           '_example:polished_stone', both at the workbench
 * - one AI:                 '_example:wander' (NPC behavior; 'wander' is
 *                           the core built-in, this shows the AIDef contract)
 * - commands:               '_example:greet', '_example:give' (hand items to
 *                           the sender), '_example:chest' (spawn a test
 *                           container next to the sender), '_example:items'
 *                           (query the item registry by tag),
 *                           '_example:station' (spawn a test workbench next
 *                           to the sender), '_example:spawn-npc' (spawn a
 *                           wandering NPC, optionally at given coordinates)
 */

/** The tutorial items — everything a feature needs to register items. */
export const EXAMPLE_ITEMS: ItemDef[] = [
  { id: '_example:herb', name: 'Mystic Herb', tags: ['herb', 'plant'], stack: 10 },
  { id: '_example:vial', name: 'Empty Vial', tags: ['vial', 'glass'], stack: 5 },
  { id: '_example:stone', name: 'Glowing Stone', tags: ['stone', 'mineral'], stack: 20 },
  // Phase 6: crafted outputs. The recipe ids equal the item ids they produce
  // — a recipe is named after its product.
  { id: '_example:glowing_essence', name: 'Glowing Essence', tags: ['essence', 'magic'], stack: 5 },
  { id: '_example:polished_stone', name: 'Polished Stone', tags: ['stone', 'crafted'], stack: 5 },
];

export default definePlugin({
  id: '_example',
  items: EXAMPLE_ITEMS,
  recipes: [
    {
      // The interop recipe: the first input matches ANY item tagged 'herb',
      // including items registered by other features (e.g. farming:seed) —
      // no feature ever imports another feature's internals.
      id: '_example:glowing_essence',
      station: '_example:workbench',
      inputs: [
        { tag: 'herb', count: 2 },
        { id: '_example:vial', count: 1 },
      ],
      outputs: [{ id: '_example:glowing_essence', count: 1 }],
      ticks: 30,
    },
    {
      id: '_example:polished_stone',
      station: '_example:workbench',
      inputs: [{ id: '_example:stone', count: 3 }],
      outputs: [{ id: '_example:polished_stone', count: 1 }],
      ticks: 20,
    },
  ],
  entityKinds: ['_example:totem', '_example:workbench'],
  systems: [
    {
      // Logs every 50 ticks (5 seconds) so it's visible but not noisy.
      name: '_example:beat',
      fn: (() => {
        let ticks = 0;
        return (world: { log: (msg: string) => void }) => {
          if (++ticks % 50 === 0) world.log(`beat (tick ${ticks})`);
        };
      })(),
    },
  ],

  ais: [
    {
      // Demo AI: the AIDef contract in miniature. The core NPC system runs
      // this (guarded) once per tick while the NPC is awake and applies
      // movement afterwards — an AI only decides state and a direction, it
      // never moves the NPC itself. `entity` is the LIVE NPC: mutations to
      // its npc/movement components are real. `nearby` are detached copies.
      name: '_example:wander',
      fn: (world, entity) => {
        const npc = entity.components.npc;
        const movement = entity.components.movement;
        if (!isNPCComponent(npc) || !isMovementComponent(movement)) return;
        // Rest a while, then wander; pick a fresh direction while wandering.
        if (world.rng() < 0.04) npc.state = npc.state === 'idle' ? 'wandering' : 'idle';
        if (npc.state === 'wandering') {
          const dirs: readonly Direction[] = ['n', 's', 'e', 'w'];
          movement.dir = dirs[~~(world.rng() * dirs.length)];
        }
      },
    },
  ],

  commands: [
    {
      name: '_example:greet',
      fn: (world, args, entityId) => {
        world.log(`greet from entity ${entityId}: ${JSON.stringify(args)}`);
      },
    },
    {
      // Test helper: hand an item to the sender. Defaults to a single herb;
      // send { item: '_example:stone', count: 25 } to test stacking limits.
      name: '_example:give',
      fn: (world, args, entityId) => {
        const payload = (typeof args === 'object' && args !== null ? args : {}) as Record<
          string,
          unknown
        >;
        const itemId = typeof payload.item === 'string' ? payload.item : '_example:herb';
        const count = typeof payload.count === 'number' && payload.count > 0 ? payload.count : 1;
        const leftover = world.give(entityId, itemId, count);
        world.log(
          `gave ${count - leftover}/${count} of '${itemId}' to entity ${entityId}` +
            (leftover > 0 ? ` (${leftover} did not fit)` : ''),
        );
      },
    },
    {
      // Test helper: spawn a container entity right next to the sender.
      name: '_example:chest',
      fn: (world, _args, entityId) => {
        const player = world.get(entityId);
        if (!player) return;
        world.spawn(
          'container',
          { x: player.x + 1, y: player.y },
          { inventory: { slots: emptySlots(INVENTORY_CAPACITY), capacity: INVENTORY_CAPACITY } },
        );
        world.log(`spawned a container next to entity ${entityId}`);
      },
    },
    {
      // Test helper: log every registered item carrying a tag — items from
      // ANY feature, since tags are the interop primitive.
      name: '_example:items',
      fn: (world, args) => {
        const payload = (typeof args === 'object' && args !== null ? args : {}) as Record<
          string,
          unknown
        >;
        const tag = typeof payload.tag === 'string' ? payload.tag : 'herb';
        const found = world.queryItemsByTag(tag);
        world.log(`items by tag '${tag}': ${found.map((i) => i.id).join(', ') || '(none)'}`);
      },
    },
    {
      // Test helper: spawn a workbench station on the first free tile next
      // to the sender. Stations are ordinary entities whose kind IS the
      // station type — '_example:workbench' is what recipes declare.
      name: '_example:station',
      fn: (world, _args, entityId) => {
        const player = world.get(entityId);
        if (!player) return;
        const offsets = [
          { x: 1, y: 0 },
          { x: -1, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: -1 },
        ];
        for (const offset of offsets) {
          const x = player.x + offset.x;
          const y = player.y + offset.y;
          if (world.tile(x, y) === 'wall') continue;
          const occupied = world.query().some((e) => e.x === x && e.y === y);
          if (occupied) continue;
          world.spawn('_example:workbench', { x, y });
          world.log(`spawned a workbench at (${x}, ${y}) next to entity ${entityId}`);
          return;
        }
        world.log(`no free tile next to entity ${entityId} - no workbench spawned`);
      },
    },
    {
      // Test helper: spawn a wandering NPC next to the sender — or, with
      // { x, y } args, at exact coordinates (handy for verifying spatial
      // sleeping: spawn one far away and it never wakes, never logs).
      // { ai: '_example:wander' } picks this feature's AI instead of the
      // core built-in 'wander'.
      name: '_example:spawn-npc',
      fn: (world, args, entityId) => {
        const payload = (typeof args === 'object' && args !== null ? args : {}) as Record<
          string,
          unknown
        >;
        const player = world.get(entityId);
        if (!player) return;
        const ai = typeof payload.ai === 'string' ? payload.ai : 'wander';

        const offsets = [
          { x: 1, y: 0 },
          { x: -1, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: -1 },
          { x: 0, y: 0 }, // last resort: the sender's own tile
        ];
        let x: number | undefined;
        let y: number | undefined;
        if (typeof payload.x === 'number' && typeof payload.y === 'number') {
          x = payload.x;
          y = payload.y;
        } else {
          for (const offset of offsets) {
            const cx = player.x + offset.x;
            const cy = player.y + offset.y;
            if (world.tile(cx, cy) === 'wall') continue;
            const occupied = world.query().some((e) => e.x === cx && e.y === cy);
            if (occupied) continue;
            x = cx;
            y = cy;
            break;
          }
        }
        if (x === undefined || y === undefined) {
          world.log(`no free tile next to entity ${entityId} - no NPC spawned`);
          return;
        }
        world.spawn('npc', { x, y }, {
          npc: { ai, state: 'idle', lastActionTick: 0, spawnChunk: `${~~(x / 64)},${~~(y / 64)}` },
          movement: { speed: 0.2, nextMoveTick: 0 },
          // Phase 7: stats make the NPC attackable (the core spawnNPC carries
          // the same defaults — this command duplicates the spawn shape).
          stats: { hp: 30, maxHp: 30, atk: 8, def: 2, level: 1 },
        });
        world.log(`spawned NPC (ai '${ai}') at (${x}, ${y})`);
      },
    },
  ],
  events: {},
});
