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
import { MAX_VIEW_OFFSET } from '@game/shared';
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

/**
 * The tile viewport for a session, centred on its CAMERA rather than its
 * player.
 *
 * The client's camera is deliberately not welded to the entity: it trails on
 * a rubber band and can be panned with free-look. Centring the snapshot on
 * the entity therefore sends the wrong tiles the moment the camera moves —
 * the client renders ground it was never given, which falls back to grass
 * and then snaps to real terrain, the flicker along the moving edge.
 *
 * The reported centre is clamped to MAX_VIEW_OFFSET tiles from the player,
 * so a forged client gains at most a short peek, never free reconnaissance.
 */
function viewportOf(entity: Entity, view?: { x: number; y: number }): Viewport {
  let cx = entity.x;
  let cy = entity.y;
  if (view) {
    const dx = view.x - entity.x;
    const dy = view.y - entity.y;
    cx = entity.x + (dx < -MAX_VIEW_OFFSET ? -MAX_VIEW_OFFSET : dx > MAX_VIEW_OFFSET ? MAX_VIEW_OFFSET : dx);
    cy = entity.y + (dy < -MAX_VIEW_OFFSET ? -MAX_VIEW_OFFSET : dy > MAX_VIEW_OFFSET ? MAX_VIEW_OFFSET : dy);
  }
  return {
    minX: cx - VIEW_RADIUS_X,
    minY: cy - VIEW_RADIUS_Y,
    maxX: cx + VIEW_RADIUS_X,
    maxY: cy + VIEW_RADIUS_Y,
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
      // World wraps like a torus — world.tile() already wraps coordinates.
      const kind = world.tile(x, y);
      if (kind === 'grass') continue;
      // Use the local (viewport-space) coordinates so the client places
      // tiles where they appear, even when they come from the opposite edge.
      tiles.push({ x, y, kind });
      byKey.set(`${x},${y}`, kind);
    }
  }
  return { tiles, byKey };
}

/** Every entity inside the player's exact tile viewport. */
function entitiesInViewport(world: World, entity: Entity, vp: Viewport): EntityState[] {
  // Centre the chunk scan on the VIEWPORT, not the entity: with the camera
  // panned away, entities near the view edge live in chunks the player's own
  // chunk ring does not reach.
  void entity;
  // Scan the chunk range covering the viewport; entity coordinates are
  // already wrapped (moveEntity normalises them), so the spatial-index
  // ring around the player's chunk catches everything nearby, including
  // entities that just wrapped across an edge.
  const chunk = worldToChunk((vp.minX + vp.maxX) >> 1, (vp.minY + vp.maxY) >> 1);
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
  view?: { x: number; y: number },
): FullSnapshot | DeltaSnapshot {
  const vp = viewportOf(entity, view);
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
