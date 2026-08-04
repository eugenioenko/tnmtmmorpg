import { defineClient, type Intent, type ItemDef } from '@game/shared';

/**
 * Client half of the farming feature: registers the seed item so the
 * inventory panel and recipe browser can name it, plus a tiny panel with a
 * 'give seeds' button. Nothing here knows about _example — the tag 'herb'
 * is the only shared vocabulary.
 */

const ITEMS: ItemDef[] = [
  { id: 'farming:seed', name: 'Seed Bundle', tags: ['herb', 'seed'], stack: 50 },
];

export default defineClient({
  items: ITEMS,
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
  sprites: {},
});
