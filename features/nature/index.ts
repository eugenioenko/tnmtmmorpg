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

/** Half the side of the scatter box: bushes/trees appear within this many
 * tiles of the world centre (players always spawn near the centre). */
const SPAWN_RADIUS = 200;

export default definePlugin({
  id: 'nature',
  entityKinds: ['nature:bush', 'nature:tree'],
  systems: [
    {
      name: 'nature:generate',
      fn: (world) => {
        // One-time bootstrap. getSet with a value stores and returns the
        // previous value: the first run sees undefined and scatters, every
        // later run (restarts included) sees '1' and returns immediately.
        if (world.getSet('nature:seeded', '1') !== undefined) return;

        const cx = (world.width / 2) | 0;
        const cy = (world.height / 2) | 0;
        let bushes = 0;
        let trees = 0;
        for (let dy = -SPAWN_RADIUS; dy <= SPAWN_RADIUS; dy++) {
          for (let dx = -SPAWN_RADIUS; dx <= SPAWN_RADIUS; dx++) {
            const kind = world.tile(cx + dx, cy + dy);
            const roll = world.rng(); // seeded: a given seed scatters the same population
            const onGrass = kind === 'grass' || kind === 'forest';
            if (roll < 0.008 && onGrass) {
              // Trees: 0.5-1% chance on grass and forest.
              world.spawn('nature:tree', { x: cx + dx, y: cy + dy });
              trees++;
            } else if (roll < 0.03 && (onGrass || kind === 'swamp')) {
              // Bushes: 1-3% chance on grass, forest and swamp.
              world.spawn('nature:bush', { x: cx + dx, y: cy + dy });
              bushes++;
            }
          }
        }
        world.log(
          `seeded ${bushes} bushes and ${trees} trees near the world centre ` +
            `(±${SPAWN_RADIUS} tiles)`,
        );
      },
    },
  ],
  commands: [],
  events: {},
  items: [],
  recipes: [],
});
