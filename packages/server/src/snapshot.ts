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
  /** Which world the last snapshot described; a change forces a full resync. */
  world: string;
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
function scanTiles(
  world: World,
  vp: Viewport,
  inWorld: string,
): { tiles: TileState[]; byKey: Map<string, string> } {
  const tiles: TileState[] = [];
  const byKey = new Map<string, string>();
  // Grass is the client's default for anything it was not told about, which
  // is wrong inside a building: there, "not told about" must read as void.
  // So interiors send every tile and skip nothing.
  const spec = world.spec(inWorld);
  const skip = spec?.generator === 'rooms' ? null : 'grass';
  const w = spec?.width ?? 0;
  const h = spec?.height ?? 0;

  for (let y = vp.minY; y <= vp.maxY; y++) {
    for (let x = vp.minX; x <= vp.maxX; x++) {
      // Emit WRAPPED coordinates. The viewport is a rectangle around the
      // player and freely runs negative or past the far edge — the world is
      // a torus, so those are real tiles, but their raw coordinates are not
      // encodable: tile x and y go on the wire as uint16, and writeU16(-12)
      // throws. That killed the whole snapshot for that session, and since
      // the client ignored frames it could not decode, the screen simply
      // stopped updating with nothing to say why.
      //
      // It bites hardest in a small world (a 48-tile interior inside a
      // 73-tile viewport is always partly out of range) but the overworld
      // has the same edge at x or y near 0.
      const wx = w > 0 ? ((x % w) + w) % w : x;
      const wy = h > 0 ? ((y % h) + h) % h : y;
      const kind = world.tile(wx, wy, inWorld);
      if (skip !== null && kind === skip) continue;
      // byKey doubles as the dedupe: a world narrower than the viewport
      // wraps onto itself, and the same tile must only be sent once.
      const key = `${wx},${wy}`;
      if (byKey.has(key)) continue;
      byKey.set(key, kind);
      tiles.push({ x: wx, y: wy, kind });
    }
  }
  return { tiles, byKey };
}

/** Every entity inside the player's exact tile viewport. */
function entitiesInViewport(world: World, entity: Entity, vp: Viewport): EntityState[] {
  // Centre the chunk scan on the VIEWPORT, not the entity: with the camera
  // panned away, entities near the view edge live in chunks the player's own
  // chunk ring does not reach.
  // Scan the chunk range covering the viewport; entity coordinates are
  // already wrapped (moveEntity normalises them), so the spatial-index
  // ring around the player's chunk catches everything nearby, including
  // entities that just wrapped across an edge.
  const chunk = worldToChunk((vp.minX + vp.maxX) >> 1, (vp.minY + vp.maxY) >> 1);
  // Scoped to the viewer's world, so a player standing at (5000,5000) in the
  // fire world never sees the crowd standing on the same tile at home.
  return world
    .entitiesInView(chunk.cx, chunk.cy, VIEW_RADIUS_X, VIEW_RADIUS_Y, entity.world)
    .filter((e) => e.x >= vp.minX && e.x <= vp.maxX && e.y >= vp.minY && e.y <= vp.maxY)
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      x: e.x,
      y: e.y,
      components: e.id === entity.id ? e.components : publicComponents(e.components),
    }));
}

let privateComponents: ReadonlySet<string> = new Set();

/** Components that features declared owner-only; set once at boot. */
export function setPrivateComponents(names: ReadonlySet<string>): void {
  privateComponents = names;
}

function publicComponents(components: Record<string, unknown>): Record<string, unknown> {
  if (privateComponents.size === 0) return components;
  let out: Record<string, unknown> | null = null;
  for (const name of privateComponents) {
    if (!(name in components)) continue;
    out ??= { ...components };
    delete out[name];
  }
  return out ?? components;
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
  const { tiles: tileList, byKey: tileMap } = scanTiles(world, vp, entity.world);

  const prev = sessions.get(sessionId);
  // Changing world invalidates every tile and entity the client holds, so it
  // has to be a full snapshot — a delta against the old world would leave
  // the previous map's tiles on screen underneath the new one.
  if (!prev || prev.world !== entity.world || tick - prev.tickOfLastFull >= FULL_RESYNC_TICKS) {
    const full: FullSnapshot = {
      t: 'full',
      tick,
      entities,
      tiles: tileList,
      playerX: entity.x,
      playerY: entity.y,
      world: entity.world,
    };
    if (disabledFeatures.length > 0) full.disabledFeatures = disabledFeatures;
    sessions.set(sessionId, {
      lastViewport: vp,
      lastEntityIds: entityIds,
      lastTiles: tileMap,
      tickOfLastFull: tick,
      world: entity.world,
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
    world: entity.world,
  };
  if (disabledFeatures.length > 0) delta.disabledFeatures = disabledFeatures;
  sessions.set(sessionId, {
    lastViewport: vp,
    lastEntityIds: entityIds,
    lastTiles: tileMap,
    tickOfLastFull: prev.tickOfLastFull,
    world: entity.world,
  });
  return delta;
}
