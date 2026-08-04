import type { RecipeDef } from '@game/shared';

/**
 * Client-side recipe registry. The server pushes the full recipe registry
 * once per connection (recipes are immutable at runtime), and the recipe
 * browser panel reads it from here — features never duplicate their recipe
 * definitions on the client.
 */

const recipes = new Map<string, RecipeDef>();

/** Replace the registry with a freshly pushed copy from the server. */
export function registerRecipes(defs: RecipeDef[]): void {
  recipes.clear();
  for (const def of defs) recipes.set(def.id, def);
}

/** The recipe with this id, or undefined (no recipes yet / feature disabled). */
export function getRecipe(id: string): RecipeDef | undefined {
  return recipes.get(id);
}

/** Every registered recipe, in registration order. */
export function allRecipes(): RecipeDef[] {
  return [...recipes.values()];
}
