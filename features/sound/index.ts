import { definePlugin } from '@game/shared';

/**
 * Sound: generative music and ambience per zone, synthesised in the browser
 * (see client.tsx). The server half exists only so the feature loads.
 */
export default definePlugin({
  id: 'sound',
  items: [],
  recipes: [],
  entityKinds: [],
  systems: [],
  commands: [],
  events: {},
});
