import { definePlugin } from '@game/shared';

/**
 * The nature feature — bushes and trees scattered as stationary entities
 * across the terrain.
 *
 * - two entity kinds:      'nature:bush', 'nature:tree'
 * - one decorateChunk hook: scatters a chunk the first time it is generated
 *
 * Bushes and trees are plain entities with no components at all: they render
 * (🌿/🌳 via client.tsx), persist like every other entity, and never move or
 * block anything.
 *
 * Scattering rides the chunk-generation hook rather than a tick system or a
 * one-shot bootstrap. The world is 10000x10000 and generated lazily, so the
 * old "decorate a box near spawn once" approach left 99.9% of the world bare
 * forever; this way growth appears wherever players actually walk, for as
 * long as they keep exploring. Core calls the hook once per chunk at a tick
 * boundary and never again — chunks restored from the database are not
 * re-decorated, so a restart cannot grow a second crop.
 *
 * `rng` is seeded per chunk by core. Using `world.rng()` here would be a bug:
 * it is one shared sequence, so a chunk's contents would depend on the order
 * players happened to explore in rather than on the world seed.
 */

/** Chance a given eligible tile sprouts a tree. */
const TREE_CHANCE = 0.008;
/** Chance a given eligible tile sprouts a bush (rolled after trees). */
const BUSH_CHANCE = 0.03;

export default definePlugin({
  id: 'nature',
  entityKinds: ['nature:bush', 'nature:tree', 'nature:rock', 'nature:stump'],
  systems: [],
  commands: [],
  events: {
    'buildings:village-ready': (world, payload) => {
      const at = payload as { x: number; y: number };
      for (const entity of world.queryNear(at.x, at.y, 23)) {
        if (!entity.kind.startsWith('nature:')) continue;
        const ground = world.tile(entity.x, entity.y);
        if (ground !== 'grass' && ground !== 'forest' && ground !== 'swamp') {
          world.despawn(entity.id);
        }
      }
    },
  },
  items: [],
  recipes: [],

  decorateChunk: (world, area, rng) => {
    for (let y = area.minY; y <= area.maxY; y++) {
      for (let x = area.minX; x <= area.maxX; x++) {
        const tile = world.tile(x, y);
        // Roads stay clear, and nothing grows on water, sand, snow or rock.
        const woodland = tile === 'grass' || tile === 'forest';
        if (!woodland && tile !== 'swamp') continue;
        // Keep the starting square and the fronts of village buildings clear.
        const dx = x - world.width / 2;
        const dy = y - world.height / 2;
        if (dx >= -11 && dx <= 11 && dy >= -9 && dy <= 9) continue;

        const roll = rng();
        const trees = tile === 'forest' ? 0.055 : TREE_CHANCE;
        if (roll < trees && woodland) {
          world.spawn('nature:tree', { x, y });
        } else if (roll < trees + BUSH_CHANCE) {
          world.spawn('nature:bush', { x, y });
        } else if (roll < trees + BUSH_CHANCE + 0.012 && woodland) {
          world.spawn(
            'nature:rock',
            { x, y },
            { appearance: { frame: 'objects/boulder', scale: 1 } },
          );
        } else if (roll < trees + BUSH_CHANCE + 0.02 && woodland) {
          world.spawn(
            'nature:stump',
            { x, y },
            { appearance: { frame: 'objects/stump', scale: 1 } },
          );
        }
      }
    }
  },
});
