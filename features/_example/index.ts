import { definePlugin, emptySlots, INVENTORY_CAPACITY, type ItemDef } from '@game/shared';

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
 * - commands:               '_example:greet', '_example:give' (hand items to
 *                           the sender), '_example:chest' (spawn a test
 *                           container next to the sender), '_example:items'
 *                           (query the item registry by tag),
 *                           '_example:station' (spawn a test workbench next
 *                           to the sender)
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
      name: '_example:beat',
      fn: (world) => {
        world.log('beat');
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
  ],
  events: {},
});
