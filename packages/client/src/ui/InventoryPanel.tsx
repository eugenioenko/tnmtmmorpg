import { useState } from 'react';
import type { InventoryComponent } from '@game/shared';
import { getItemDef } from '../items.ts';
import { ItemIcon } from './ItemIcon.tsx';
import { useItem } from './Hud.tsx';
import { useSnapshots, type HudRuntime } from './runtime.ts';

function isInventory(value: unknown): value is InventoryComponent {
  if (typeof value !== 'object' || value === null) return false;
  const inv = value as Record<string, unknown>;
  return Array.isArray(inv.slots) && typeof inv.capacity === 'number';
}

/**
 * The backpack: a slot grid with drag-to-swap, a detail card for the
 * selected item, and use/drop actions. Every change is an intent; the grid
 * simply re-reads the inventory component from the next snapshot.
 */
export function InventoryPanel({ rt }: { rt: HudRuntime }) {
  useSnapshots(rt);
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const raw = rt.game.localPlayer()?.components.inventory;
  if (!isInventory(raw)) return <div className="muted">Not connected.</div>;

  const used = raw.slots.filter((slot) => slot.count > 0).length;
  const sel = selected !== null ? raw.slots[selected] : undefined;
  const selDef = sel && sel.count > 0 ? getItemDef(sel.itemId) : undefined;

  return (
    <>
      <div className="section-title">
        Pack · {used}/{raw.capacity}
      </div>
      <div className="inv-grid">
        {raw.slots.map((slot, index) => {
          const filled = slot.count > 0;
          const def = filled ? getItemDef(slot.itemId) : undefined;
          return (
            <div
              key={index}
              className={
                'inv-cell' +
                (filled ? ' filled' : '') +
                (selected === index && filled ? ' selected' : '') +
                (dragging === index ? ' dragging' : '') +
                (over === index && dragging !== null && dragging !== index ? ' over' : '')
              }
              title={def?.name ?? (filled ? slot.itemId : '')}
              draggable={filled}
              onClick={() => setSelected(filled ? index : null)}
              onDoubleClick={() => filled && useItem(rt, slot.itemId, index)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (filled) useItem(rt, slot.itemId, index);
              }}
              onDragStart={() => setDragging(index)}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== index) {
                  rt.sendIntent({ t: 'intent', kind: 'swap', a: dragging, b: index });
                  if (selected === dragging) setSelected(index);
                }
                setDragging(null);
                setOver(null);
              }}
            >
              {filled && <ItemIcon itemId={slot.itemId} size={24} />}
              {filled && slot.count > 1 && <span className="count">{slot.count}</span>}
            </div>
          );
        })}
      </div>
      <div className="item-card">
        {sel && sel.count > 0 ? (
          <>
            <div className="title">
              {selDef?.name ?? sel.itemId}
              {sel.count > 1 ? ` ×${sel.count}` : ''}
            </div>
            <div className="tags">{(selDef?.tags ?? []).join(' · ')}</div>
            {selDef?.description && <div className="desc">{selDef.description}</div>}
            {selDef?.value !== undefined && <div className="desc">Worth {selDef.value} gold</div>}
            <div className="actions">
              {selDef?.use && (
                <button type="button" className="btn small" onClick={() => useItem(rt, sel.itemId, selected!)}>
                  {selDef.useLabel ?? 'Use'}
                </button>
              )}
              <button
                type="button"
                className="btn small danger"
                onClick={() => rt.sendIntent({ t: 'intent', kind: 'drop', slot: selected! })}
              >
                Drop
              </button>
            </div>
          </>
        ) : (
          <div className="muted">
            Select an item to inspect it. Double-click or right-click to use; drag to rearrange.
          </div>
        )}
      </div>
    </>
  );
}
