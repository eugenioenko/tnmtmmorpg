import { definePlugin } from '@game/shared';

/**
 * Critters: butterflies, fireflies, falling leaves, jumping fish and
 * snowflakes. Purely client-side ambience (see client.tsx); the server half
 * exists only so the feature loads like any other.
 */
export default definePlugin({
  id: 'critters',
  items: [],
  recipes: [],
  entityKinds: [],
  systems: [],
  commands: [],
  events: {},
});
