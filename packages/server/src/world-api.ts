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
 * The sanctioned feature API. Feature code never sees the World class or
 * any other core internal: spawn/get/despawn/query/tile/setTile/give/emit/
 * emitNear/rng/log is the entire surface, and the only way to change the
 * world.
 *
 * get()/query() return detached copies of components, so features cannot
 * mutate another entity's state in place. Features change state through
 * give() (inventory, Phase 5) and by spawning, despawning and setting tiles;
 * the tick loop's intent handlers mutate entities directly, and every change
 * marks the entity dirty for persistence.
 */
export function createWorldApi({ world, bus, log, items, recipes }: WorldApiDeps): WorldAPI {
  return {
    spawn(kind: string, pos: WorldCoord, components: Record<string, unknown> = {}): number {
      return world.spawn(kind, pos, components);
    },

    get(id: number): EntityState | undefined {
      const entity = world.get(id);
      return entity ? toState(entity) : undefined;
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
      // Cast: features may introduce tile kinds beyond core's 'grass'|'wall';
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
