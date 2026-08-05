import { definePlugin } from '@game/shared';

/**
 * The nature feature — the first world-decoration feature: bushes and trees
 * scattered as stationary entities across the terrain near the world centre,
 * where players spawn.
 *
 * - two entity kinds:      'nature:bush', 'nature:tree'
 * - one system:            'nature:generate' — scatters the population once
 *
 * Bushes and trees are plain entities with only a position component: they
 * render (🌿/🌳 via client.tsx), persist like every other entity, and never
 * move or block anything.
 *
 * The scatter is a one-time bootstrap: the system checks the persistent kv
 * flag 'nature:seeded' on its first run and claims it in the same call
 * (`getSet(key, value)` stores and returns the previous value). A restarted
 * server skips; a world reset by tools/reset-world.mjs sets the same flag
 * after scattering its own population, so the two mechanisms never
 * double-seed.
 */

export default definePlugin({
  id: 'nature',
  entityKinds: ['nature:bush', 'nature:tree'],
  // Scattering happens at server boot (see packages/server/src/index.ts) 
  // before the tick loop starts, so it never hits the guard's time budget.
  systems: [],
  commands: [],
  events: {},
  items: [],
  recipes: [],
});
