import { defineClient } from '@game/shared';

/**
 * Portals: the pad glyphs, and 'portals:use' as the action for clicking a
 * pad or pressing Space beside one. The command no-ops when no pad is in
 * reach, so it can share Space with every other interaction blindly.
 */
export default defineClient({
  sprites: {
    'portals:pad': '🌀',
    'portals:return': '🏠',
  },
  interactions: {
    'portals:pad': { intent: 'portals:use', label: 'Travel to' },
    'portals:return': { intent: 'portals:use', label: 'Travel' },
  },
});
