/**
 * Per-session snapshot diff engine.
 *
 * The first snapshot for a session is a full view of its player's viewport;
 * subsequent snapshots are deltas. Entities are included wholesale in every
 * delta (typically 1-20 per viewport, and they move every tick), while
 * tiles — the bulk of the old snapshot, ~2400 per 60x40 viewport — are only
 * sent when they change: newly visible, changed in place, or gone from the
 * viewport. A fresh full snapshot every 300 ticks (30s at 10Hz) resyncs the
 * client in case anything drifted.
 *
 * Each session's diff state tracks exactly what the client knows: the tiles
 * it was told about (key "x,y" -> kind, non-grass only — grass is the client
 * default and never sent) and the entity ids in its viewport. Sessions that
 * disconnect are dropped via `forgetSession`.
 */

import type {
  DeltaSnapshot,
  EntityState,
  FullSnapshot,
  TileState,
  WorldCoord,
} from '@game/shared';
import {
  VIEW_RADIUS_X,
  VIEW_RADIUS_Y,
  worldToChunk,
  type Entity,
  type World,
} from './world.ts';

interface Viewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface SessionState {
  lastViewport: Viewport;
  lastEntityIds: Set<number>;
  /** Key "x,y" -> kind, for every non-grass tile the client was told about. */
  lastTiles: Map<string, string>;
  tickOfLastFull: number;
}

/** A fresh full snapshot every 300 ticks (30 seconds at 10Hz) resyncs the client. */
const FULL_RESYNC_TICKS = 300;

const sessions = new Map<string, SessionState>();

/** Drop a session's diff state — on disconnect, or when its entity is gone. */
export function forgetSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** The clamped tile viewport around a player (world edges included). */
function viewportOf(entity: Entity, world: World): Viewport {
  const x0 = entity.x - VIEW_RADIUS_X;
  const y0 = entity.y - VIEW_RADIUS_Y;
  return {
    minX: x0 < 0 ? 0 : x0,
    minY: y0 < 0 ? 0 : y0,
    maxX: entity.x + VIEW_RADIUS_X >= world.width ? world.width - 1 : entity.x + VIEW_RADIUS_X,
    maxY: entity.y + VIEW_RADIUS_Y >= world.height ? world.height - 1 : entity.y + VIEW_RADIUS_Y,
  };
}

/**
 * Every non-grass tile in the viewport, as both a TileState list and a
 * keyed map. Grass (the world default) is never sent: the client renders
 * grass for any coordinate it has not been told about.
 */
function scanTiles(world: World, vp: Viewport): { tiles: TileState[]; byKey: Map<string, string> } {
  const tiles: TileState[] = [];
  const byKey = new Map<string, string>();
  for (let y = vp.minY; y <= vp.maxY; y++) {
    for (let x = vp.minX; x <= vp.maxX; x++) {
      const kind = world.tile(x, y);
      if (kind === 'grass') continue;
      tiles.push({ x, y, kind });
      byKey.set(`${x},${y}`, kind);
    }
  }
  return { tiles, byKey };
}

/** Every entity inside the player's exact tile viewport. */
function entitiesInViewport(world: World, entity: Entity, vp: Viewport): EntityState[] {
  const chunk = worldToChunk(entity.x, entity.y);
  return world
    .entitiesInView(chunk.cx, chunk.cy, VIEW_RADIUS_X, VIEW_RADIUS_Y)
    .filter((e) => e.x >= vp.minX && e.x <= vp.maxX && e.y >= vp.minY && e.y <= vp.maxY)
    .map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, components: e.components }));
}

/** Parse a "x,y" tile key back into world coordinates. */
function parseKey(key: string): { x: number; y: number } {
  const comma = key.indexOf(',');
  return { x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)) };
}

/**
 * One snapshot for one player: a `full` on first build and every 300 ticks,
 * a `delta` in between. The delta contains all viewport entities, the tiles
 * that changed since the last snapshot, the tiles that left the viewport,
 * and the entity ids that left the viewport.
 */
export function buildSnapshot(
  world: World,
  entity: Entity,
  tick: number,
  disabledFeatures: string[],
  sessionId: string,
): FullSnapshot | DeltaSnapshot {
  const vp = viewportOf(entity, world);
  const entities = entitiesInViewport(world, entity, vp);
  const entityIds = new Set(entities.map((e) => e.id));
  const { tiles: tileList, byKey: tileMap } = scanTiles(world, vp);

  const prev = sessions.get(sessionId);
  if (!prev || tick - prev.tickOfLastFull >= FULL_RESYNC_TICKS) {
    const full: FullSnapshot = {
      t: 'full',
      tick,
      entities,
      tiles: tileList,
      playerX: entity.x,
      playerY: entity.y,
    };
    if (disabledFeatures.length > 0) full.disabledFeatures = disabledFeatures;
    sessions.set(sessionId, {
      lastViewport: vp,
      lastEntityIds: entityIds,
      lastTiles: tileMap,
      tickOfLastFull: tick,
    });
    return full;
  }

  // Tiles the client does not know about yet, or whose kind changed.
  const changedTiles: TileState[] = [];
  for (const [key, kind] of tileMap) {
    if (prev.lastTiles.get(key) !== kind) {
      const { x, y } = parseKey(key);
      changedTiles.push({ x, y, kind });
    }
  }

  // Tiles the client was told about that are gone now: they left the
  // viewport, or they changed to grass in place — either way the client
  // reverts them to the grass default.
  const removedTiles: WorldCoord[] = [];
  for (const key of prev.lastTiles.keys()) {
    if (!tileMap.has(key)) {
      removedTiles.push(parseKey(key));
    }
  }

  // Entities that left the viewport (or despawned).
  const removedEntities: number[] = [];
  for (const id of prev.lastEntityIds) {
    if (!entityIds.has(id)) removedEntities.push(id);
  }

  const delta: DeltaSnapshot = {
    t: 'delta',
    tick,
    entities,
    removedEntities,
    tiles: changedTiles,
    removedTiles,
    playerX: entity.x,
    playerY: entity.y,
  };
  if (disabledFeatures.length > 0) delta.disabledFeatures = disabledFeatures;
  sessions.set(sessionId, {
    lastViewport: vp,
    lastEntityIds: entityIds,
    lastTiles: tileMap,
    tickOfLastFull: prev.tickOfLastFull,
  });
  return delta;
}
