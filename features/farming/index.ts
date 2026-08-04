import { definePlugin, type ItemDef } from '@game/shared';

/**
 * The farming feature — deliberately tiny: its whole job is to prove that
 * features compose through tags with zero coordination. It registers one
 * item, 'farming:seed', tagged 'herb'. Nothing here knows about _example;
 * nevertheless _example's recipe '_example:glowing_essence' (which requires
 * { tag: 'herb', count: 2 }) will happily consume farming seeds — the craft
 * intent matches inputs against the GLOBAL item registry by tag.
 *
 * This is the Phase 6 interop test: recipe in feature A, item in feature B,
 * no code shared between them.
 */

const ITEMS: ItemDef[] = [
  { id: 'farming:seed', name: 'Seed Bundle', tags: ['herb', 'seed'], stack: 50 },
];

export default definePlugin({
  id: 'farming',
  items: ITEMS,
  recipes: [],
  entityKinds: [],
  systems: [],
  commands: [
    {
      // Test helper: hand the sender a handful of seeds.
      name: 'farming:give',
      fn: (world, _args, entityId) => {
        const count = 4;
        const leftover = world.give(entityId, 'farming:seed', count);
        world.log(
          `gave ${count - leftover}/${count} 'farming:seed' to entity ${entityId}` +
            (leftover > 0 ? ` (${leftover} did not fit)` : ''),
        );
      },
    },
  ],
  events: {},
});
