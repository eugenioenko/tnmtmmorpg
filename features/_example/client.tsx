import { defineClient, type Intent, type ItemDef } from '@game/shared';

/**
 * Optional client half of a feature: items (names/emoji for the inventory
 * panel), UI panels and sprite glyphs. Loaded by the client's
 * import.meta.glob at boot — no core client file is touched. Panels are
 * zero-prop React components rendered into the overlay; sprites map entity
 * kinds to emoji glyphs.
 *
 * Phase 6: the workbench registers a sprite glyph (⚒️) and the crafted
 * outputs register names for the inventory panel and recipe browser. The
 * recipe browser itself is core (RecipePanel), driven by the recipe registry
 * the server pushes on connect — a feature only declares recipes server-side.
 */

const ITEMS: ItemDef[] = [
  { id: '_example:herb', name: 'Mystic Herb', tags: ['herb', 'plant'], stack: 10 },
  { id: '_example:vial', name: 'Empty Vial', tags: ['vial', 'glass'], stack: 5 },
  { id: '_example:stone', name: 'Glowing Stone', tags: ['stone', 'mineral'], stack: 20 },
  { id: '_example:glowing_essence', name: 'Glowing Essence', tags: ['essence', 'magic'], stack: 5 },
  { id: '_example:polished_stone', name: 'Polished Stone', tags: ['stone', 'crafted'], stack: 5 },
];

export default defineClient({
  items: ITEMS,
  panels: {
    '_example:panel': ({ sendIntent }: { sendIntent: (intent: Intent) => void }) => (
      <div className="feature-panel">
        Example Feature Active
        <div className="feature-buttons">
          <button
            type="button"
            onClick={() =>
              sendIntent({ t: 'intent', kind: '_example:give', item: '_example:herb' })
            }
          >
            +herb
          </button>
          <button
            type="button"
            onClick={() =>
              sendIntent({ t: 'intent', kind: '_example:give', item: '_example:stone', count: 25 })
            }
          >
            +25 stone
          </button>
          <button type="button" onClick={() => sendIntent({ t: 'intent', kind: '_example:chest' })}>
            +chest
          </button>
          <button
            type="button"
            onClick={() => sendIntent({ t: 'intent', kind: '_example:station' })}
          >
            +workbench
          </button>
        </div>
      </div>
    ),
  },
  sprites: {
    '_example:totem': '🗿',
    '_example:workbench': '⚒️',
  },
});
