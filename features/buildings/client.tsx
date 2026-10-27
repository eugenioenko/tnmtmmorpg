import { defineClient } from '@game/shared';

/**
 * Doors. Clicking one (or pressing Space beside it) sends 'buildings:enter';
 * the same command works both ways — outside it takes you in, inside it
 * takes you back out. The client's interaction layer does the walking.
 */
export default defineClient({
  sprites: {
    'buildings:door': '🚪',
    'buildings:exit': '🪜',
    'buildings:prop': '🪵',
  },
  interactions: {
    'buildings:door': { intent: 'buildings:enter', label: 'Enter' },
    'buildings:exit': { intent: 'buildings:enter', label: 'Use' },
  },
});
