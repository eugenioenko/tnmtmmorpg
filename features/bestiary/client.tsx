import { defineClient } from '@game/shared';
import { LOOT } from './index.ts';

export default defineClient({
  items: LOOT,
  sprites: { 'bestiary:monster': '🐺' },
});
