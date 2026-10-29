import { definePlugin } from '@game/shared';

/**
 * Smoke from cottage chimneys, campfires, the forge and the oven, steam off
 * the cauldron and fresh lightning scars. Purely client-side (see
 * client.tsx); the server half exists only so the feature loads like any
 * other.
 */
export default definePlugin({
  id: 'smoke',
  items: [],
  recipes: [],
  entityKinds: [],
  systems: [],
  commands: [],
  events: {},
});
