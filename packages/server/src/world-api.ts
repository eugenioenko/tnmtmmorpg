import {
  itemsByTag,
  type EntityState,
  type ItemDef,
  type RecipeDef,
  type WorldAPI,
  type WorldCoord,
} from '@game/shared';
import type { EventBus } from './events.ts';
import type { TileKind, World } from './world.ts';
import { giveItem } from './systems/inventory.ts';
import { getAvailableRecipes } from './systems/crafting.ts';

export interface WorldApiDeps {
  world: World;
  bus: EventBus;
  log: (msg: string) => void;
  /** Phase 5: item definitions power give()'s stack limits and tag queries. */
  items: ReadonlyMap<string, ItemDef>;
  /** Phase 6: recipe definitions power station recipe queries. */
  recipes: ReadonlyMap<string, RecipeDef>;
}

function toState(entity: {
  id: number;
  kind: string;
  x: number;
  y: number;
  components: Record<string, unknown>;
}): EntityState {
  // Detached copy: reading is safe, mutation is impossible by construction.
  return {
    id: entity.id,
    kind: entity.kind,
    x: entity.x,
    y: entity.y,
    components: { ...entity.components },
  };
}

/**
 * Component names a patch may never set: an entity's identity and its place
 * in the world. Position changes go through movement (core), never through a
 * component patch, so the spatial index and the chunk key cannot drift.
 */
const PROTECTED_KEYS = new Set(['id', 'kind', 'x', 'y', 'chunk']);

/**
 * The sanctioned feature API. Feature code never sees the World class or
 * any other core internal: spawn/get/update/despawn/query/tile/setTile/give/
 * emit/emitNear/rng/log is the entire surface, and the only way to change
 * the world.
 *
 * get()/query() return detached copies, so nothing is ever mutated by
 * accident: a component change is an explicit update() call naming the
 * entity. That read-copy/write-back split is what lets game content — hp
 * changes, crop growth, buffs — live in features instead of core. Every
 * change marks the entity dirty for persistence.
 */
export function createWorldApi({ world, bus, log, items, recipes }: WorldApiDeps): WorldAPI {
  return {
    width: world.width,
    height: world.height,

    getSet(k: string, v?: string): string | undefined {
      return world.getSet(k, v);
    },

    spawn(kind: string, pos: WorldCoord, components: Record<string, unknown> = {}): number {
      return world.spawn(kind, pos, components);
    },

    get(id: number): EntityState | undefined {
      const entity = world.get(id);
      return entity ? toState(entity) : undefined;
    },

    // The write half of get(): a feature reads a detached copy, builds the
    // new component value, and hands it back here. Shallow merge on the LIVE
    // entity, then dirty so it persists. Identity and position keys are
    // silently dropped — movement is core's, not a component patch.
    update(entityId: number, patch: Record<string, unknown>): boolean {
      const entity = world.get(entityId);
      if (!entity) return false;
      for (const [key, value] of Object.entries(patch)) {
        if (PROTECTED_KEYS.has(key)) continue;
        entity.components[key] = value;
      }
      world.markDirty(entityId);
      return true;
    },

    despawn(id: number): void {
      world.despawn(id);
    },

    query(...componentNames: string[]): EntityState[] {
      return world.query(...componentNames).map(toState);
    },

    tile(x: number, y: number): string {
      return world.tile(x, y);
    },

    setTile(x: number, y: number, kind: string): void {
      // Cast: features may introduce tile kinds beyond the 8 core terrain kinds;
      // unknown kinds render with the client's fallback color.
      world.setTile(x, y, kind as TileKind);
    },

    // Phase 5: delegate to the core inventory system; leftover means
    // "not accepted" (unknown item, no inventory component, or full).
    give(entityId: number, itemId: string, count: number): number {
      return giveItem({ world, items }, entityId, itemId, count);
    },

    // Tags are the interop primitive: this returns items registered by ANY
    // feature, so a recipe or system never needs to know where an item lives.
    queryItemsByTag(tag: string): ItemDef[] {
      return itemsByTag([...items.values()], tag);
    },

    // Phase 6: recipes craftable at a station entity, matched by the
    // station's entity kind ('_example:workbench' -> its recipes).
    getAvailableRecipes(stationEntityId: number): RecipeDef[] {
      return getAvailableRecipes({ world, items, recipes }, stationEntityId);
    },

    emit(event: string, payload: unknown): void {
      bus.emit(event, payload);
    },

    emitNear(x: number, y: number, radius: number, event: string, payload: unknown): void {
      bus.emitNear(x, y, radius, event, payload);
    },

    rng(): number {
      return world.rng();
    },

    log,
  };
}
