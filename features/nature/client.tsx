import { defineClient } from '@game/shared';

/**
 * Client half of the nature feature: sprite glyphs for the decorative
 * entities. Registered via the client's import.meta.glob at boot — no core
 * client file changes. Bushes and trees are stationary entities, so they
 * need no panels or items.
 */
export default defineClient({
  sprites: {
    'nature:bush': '🌿',
    'nature:tree': '🌳',
  },
});
