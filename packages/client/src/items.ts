import type { ItemDef } from '@game/shared';

/**
 * Client-side item registry: every item definition shipped by the loaded
 * feature client.tsx modules. The inventory panel uses it to turn bare
 * item ids from snapshots into names and tags.
 */

const items = new Map<string, ItemDef>();

/** Register the items declared by one feature's client plugin. */
export function registerItems(defs: ItemDef[]): void {
  for (const def of defs) items.set(def.id, def);
}

/** The item definition for an id, or undefined (unknown / feature not loaded). */
export function getItemDef(itemId: string): ItemDef | undefined {
  return items.get(itemId);
}
