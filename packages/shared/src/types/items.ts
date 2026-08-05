/** Item definition. Stub for now — refined in Phase 5. */
export interface ItemDef {
  id: string;
  name: string;
  tags: string[];
  stack: number;
}

/** One input requirement of a recipe: match by exact item id OR by tag. */
export interface RecipeInput {
  /** Match any registered item carrying this tag (the interop primitive). */
  tag?: string;
  /** OR match this exact item id. */
  id?: string;
  count: number;
}

export interface RecipeOutput {
  id: string;
  count: number;
}

/**
 * A crafting recipe. `station` is the entity kind of the station it requires
 * (e.g. 'alchemy:cauldron'); it is what the recipe browser filters on and
 * what the craft intent gates against. `ticks` is the crafting duration in
 * ticks (10 ticks per second).
 */
export interface RecipeDef {
  id: string;
  station: string;
  inputs: RecipeInput[];
  outputs: RecipeOutput[];
  ticks: number;
}

/** All item definitions carrying a tag — the cross-feature interop primitive. */
export function itemsByTag(items: readonly ItemDef[], tag: string): ItemDef[] {
  return items.filter((item) => item.tags.includes(tag));
}
