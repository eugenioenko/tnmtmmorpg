import { useEffect, useState } from 'react';
import type { Intent, InventoryComponent } from '@game/shared';
import type { Game } from '../game.ts';
import { emojiForItem } from '../emoji-atlas.ts';
import { getItemDef } from '../items.ts';

const POLL_MS = 200;

/** Window event toggling the panel; the 'I' key in index.tsx dispatches it. */
export const INVENTORY_TOGGLE_EVENT = 'tnmt:inventory-toggle';

/** Runtime shape check — snapshot component blobs are plain JSON. */
function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

/**
 * Phase 5 inventory panel: reads the local player's inventory component from
 * the newest game snapshot (polled, like the debug panel) and lets the
 * player drop items, drag-and-drop slots to swap, and open/close the panel
 * with the 'I' key or the toggle button. All mutations go through intents —
 * the server is authoritative.
 */
export function InventoryPanel({
  game,
  sendIntent,
}: {
  game: Game;
  sendIntent: (intent: Intent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<InventoryComponent | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const player = game.localPlayer();
      const raw = player?.components.inventory;
      setInventory(
        isInventory(raw)
          ? { capacity: raw.capacity, slots: raw.slots.map((slot) => ({ ...slot })) }
          : null,
      );
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [game]);

  useEffect(() => {
    const onToggle = () => setOpen((value) => !value);
    window.addEventListener(INVENTORY_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(INVENTORY_TOGGLE_EVENT, onToggle);
  }, []);

  // When closed, just a small backpack button.
  if (!open) {
    return (
      <button
        type="button"
        className="inv-toggle-btn"
        aria-label="open inventory"
        onClick={(event) => {
          setOpen(true);
          event.currentTarget.blur(); // keep the 'I' key working afterwards
        }}
      >
        🎒
      </button>
    );
  }

  const used = inventory ? inventory.slots.filter((slot) => slot.count > 0).length : 0;

  return (
    <div
      className="inventory-panel"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="inv-header">
        <span>Inventory</span>
        <span className="inv-capacity">{inventory ? `${used}/${inventory.capacity}` : '–'}</span>
        <button
          type="button"
          className="inv-close"
          aria-label="close inventory"
          onClick={(event) => {
            setOpen(false);
            event.currentTarget.blur();
          }}
        >
          ✕
        </button>
      </div>

      {inventory ? (
        <div className="inv-slot-grid">
          {inventory.slots.map((slot, index) => {
            const def = slot.count > 0 ? getItemDef(slot.itemId) : undefined;
            return (
              <div
                key={index}
                className={
                  `inv-slot${slot.count > 0 ? '' : ' inv-slot-empty'}` +
                  (dragging === index ? ' inv-slot-dragging' : '')
                }
                draggable={slot.count > 0}
                onDragStart={() => setDragging(index)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== null && dragging !== index) {
                    sendIntent({ t: 'intent', kind: 'swap', a: dragging, b: index });
                  }
                  setDragging(null);
                }}
              >
                {slot.count > 0 && (
                  <>
                    <span className="inv-emoji">{emojiForItem(slot.itemId, def?.tags)}</span>
                    <span className="inv-name" title={slot.itemId}>
                      {def?.name ?? slot.itemId}
                    </span>
                    <span className="inv-count">×{slot.count}</span>
                    <button
                      type="button"
                      className="inv-drop-btn"
                      title={`drop ${def?.name ?? slot.itemId} on the ground`}
                      onClick={(event) => {
                        sendIntent({ t: 'intent', kind: 'drop', slot: index });
                        event.currentTarget.blur();
                      }}
                    >
                      drop
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="inv-empty">no inventory — connect to the server</div>
      )}

      <div className="inv-hint">I: toggle · drag a slot onto another to swap</div>
    </div>
  );
}
