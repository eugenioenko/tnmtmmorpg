import { emojiForItem } from '../emoji-atlas.ts';
import { getItemDef } from '../items.ts';

export function ItemIcon({ itemId, size = 24 }: { itemId: string; size?: number }) {
  return (
    <span style={{ fontSize: size, lineHeight: 1 }}>
      {emojiForItem(itemId, getItemDef(itemId)?.tags)}
    </span>
  );
}
