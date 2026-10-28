import { defineClient, type Intent } from '@game/shared';
import { ITEMS } from './index.ts';

export default defineClient({
  items: ITEMS,
  interactions: {
    'farming:plot': { intent: 'farming:tend', label: 'Tend', range: 1 },
    'farming:oven': { intent: 'farming:bake', label: 'Bake at', opens: 'crafting' },
  },
  panels: {
    'farming:panel': ({ sendIntent }: { sendIntent: (intent: Intent) => void }) => (
      <div className="feature-panel">
        Farming
        <div className="feature-buttons">
          <button type="button" onClick={() => sendIntent({ t: 'intent', kind: 'farming:give' })}>
            +4 seeds
          </button>
        </div>
      </div>
    ),
  },
});
