import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  emptySlots,
  encodeServerMessage,
  INVENTORY_CAPACITY,
  TILE_SIZE,
  VISIBLE_RADIUS_X,
  VISIBLE_RADIUS_Y,
  type Intent,
  type Pong,
  type RecipeDef,
  type RecipesMessage,
  type ServerMessage,
  type WelcomeMessage,
  type WorldCoord,
} from '@game/shared';
import type { World } from './world.ts';
import { forgetSession } from './snapshot.ts';

export interface WsServer {
  /**
   * Build and send one snapshot per connected session, tailored to that
   * player's view. The callback receives the session's entity id and its
   * session id (which the snapshot diff engine keys per-session state on).
   */
  broadcast(
    buildPlayerSnapshot: (
      entityId: number,
      sessionId: string,
      view?: { x: number; y: number },
    ) => ServerMessage,
  ): void;
  /** Number of connected sessions; read once per tick by the profiler. */
  sessionCount(): number;
  close(): void;
}

export interface WsServerOptions {
  port: number;
  /** Route an intent from a session to the tick loop's intent queue. */
  enqueueIntent: (entityId: number, intent: Intent) => void;
  /** Phase 6: the recipe registry, pushed to each client on connect. */
  recipes: RecipeDef[];
  /**
   * Profiling hook: called after each snapshot is encoded, with the wire
   * bytes (a string for JSON sessions, a Uint8Array for binary sessions).
   * Wired only when profiling is enabled, so unprofiled servers pay nothing.
   */
  onSnapshot?: (msg: ServerMessage, data: string | Uint8Array) => void;
}

interface Session {
  id: string;
  socket: WebSocket;
  entityId: number;
  color: string;
  /**
   * Where this client's camera is looking, in world tiles, or undefined
   * before it reports. Snapshots are centred here rather than on the player:
   * the camera trails on a rubber band and can be panned with free-look, so
   * the tiles the client renders are not the tiles centred on the entity.
   */
  viewX?: number;
  viewY?: number;
  /**
   * Compact binary wire format (packages/shared/src/binary.ts): true once the
   * client asks for it via `{ t: 'binary', enabled: true }`. Sessions that
   * never ask keep getting JSON — old clients and the headless bots are
   * untouched.
   */
  useBinary: boolean;
}

/** One distinct color per player, assigned in connection order. */
const PLAYER_COLORS = [
  '#e74c3c',
  '#3498db',
  '#2ecc71',
  '#f1c40f',
  '#9b59b6',
  '#1abc9c',
  '#e67e22',
  '#ff6b81',
  '#16a085',
  '#8e44ad',
];

function isIntent(value: unknown): value is Intent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.t === 'intent' && typeof obj.kind === 'string';
}

/**
 * The client pings every couple of seconds so its debug panel can show
 * latency. Pings never touch the intent queue; we echo the client's
 * timestamp back verbatim.
 */
function isView(value: unknown): value is { t: 'view'; x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.t === 'view' &&
    typeof obj.x === 'number' &&
    typeof obj.y === 'number' &&
    Number.isFinite(obj.x) &&
    Number.isFinite(obj.y)
  );
}

function isPing(value: unknown): value is { t: 'ping'; ts: number } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.t === 'ping' && typeof obj.ts === 'number';
}

/**
 * The binary-protocol handshake: a client that understands the compact
 * binary wire format says so once, right after connecting. The server then
 * sends that session binary snapshots and pongs instead of JSON. Clients
 * that never send this keep the JSON protocol — fully backward compatible.
 */
function isBinaryRequest(value: unknown): value is { t: 'binary'; enabled: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.t === 'binary' && typeof obj.enabled === 'boolean';
}

/**
	 * Players spawn in a small box at the centre of the world: close enough to
	 * see one another's activity (the world itself is 10000×10000, but every
	 * player starts here).
 */
const SPAWN_AREA = 20;

/** A random walkable tile not already occupied by another player. */
function findSpawn(world: World): WorldCoord {
  const players = world.query('player');
  const cx = (world.width / 2) | 0;
  const cy = (world.height / 2) | 0;
  const half = (SPAWN_AREA / 2) | 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = cx - half + ~~(world.rng() * SPAWN_AREA);
    const y = cy - half + ~~(world.rng() * SPAWN_AREA);
    const free = !players.some((p) => p.x === x && p.y === y);
    if (free && world.isWalkable(x, y)) return { x, y };
  }
  return { x: cx, y: cy }; // last resort — world centre
  }

export function startWsServer(world: World, options: WsServerOptions): WsServer {
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('tnmtmmorpg server - connect via WebSocket\n');
  });
  const wss = new WebSocketServer({ server: httpServer });
  const sessions = new Map<string, Session>();
  let colorIndex = 0;

  // `ws` re-emits the http server's errors (e.g. EADDRINUSE) on the
  // WebSocketServer; handle them there so a busy port fails loudly and
  // cleanly instead of crashing with an unhandled 'error' event.
  wss.on('error', (err) => {
    console.error(`[ws] failed to listen on port ${options.port}: ${err.message}`);
    process.exit(1);
  });

  wss.on('connection', (socket) => {
    const id = randomUUID();
    const color = PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length];
    const pos = findSpawn(world);
    // Phase 5: every player spawns with a fixed-size inventory.
    // Phase 7: and with a stats component — hp/atk/def, which the client's
    // health bar reads and feature-side damage rules act on.
    const entityId = world.spawn('player', pos, {
      player: { color },
      inventory: { slots: emptySlots(INVENTORY_CAPACITY), capacity: INVENTORY_CAPACITY },
      stats: { hp: 100, maxHp: 100, atk: 15, def: 5, level: 1 },
    });

    const session: Session = { id, socket, entityId, color, useBinary: false };
    sessions.set(session.id, session);

    session.socket.send(
      JSON.stringify({
        t: 'welcome',
        entityId: session.entityId,
        color: session.color,
        // The server decides how much world it sends; the client caps its
        // canvas to this so it never renders ground it was not given.
        // The DISPLAYABLE radius, not the send radius: the server sends a
        // wider window so the camera has somewhere to pan into, but the
        // client must only render this much (equal view for every monitor).
        viewRadiusX: VISIBLE_RADIUS_X,
        viewRadiusY: VISIBLE_RADIUS_Y,
        tileSize: TILE_SIZE,
      } satisfies WelcomeMessage),
    );
    // Phase 6: recipes are immutable at runtime, so one push per connect is
    // enough — the client renders the recipe browser from this registry.
    session.socket.send(
      JSON.stringify({ t: 'recipes', recipes: options.recipes } satisfies RecipesMessage),
    );
    console.log(
      `[ws] session ${session.id} connected as entity ${session.entityId} at (${pos.x}, ${pos.y})`,
    );

    session.socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        console.warn(`[ws] session ${session.id} sent non-JSON data - dropped`);
        return;
      }
      // Camera position. Clamped server-side in snapshot.ts, so a forged
      // value cannot scout the map — it is a hint, not an instruction.
      if (isView(message)) {
        session.viewX = message.x;
        session.viewY = message.y;
        return;
      }
      if (isPing(message)) {
        const pong = { t: 'pong', ts: message.ts } satisfies Pong;
        session.socket.send(session.useBinary ? encodeServerMessage(pong) : JSON.stringify(pong));
        return;
      }
      // Binary-protocol handshake: switch this session to the compact binary
      // wire format. Welcome and recipes already went out in JSON (they are
      // sent on connect, before any client message arrives) — the client
      // handles both encodings for every message type.
      if (isBinaryRequest(message)) {
        session.useBinary = message.enabled;
        console.log(
          `[ws] session ${session.id} switched to ${message.enabled ? 'binary' : 'JSON'} protocol`,
        );
        return;
      }
      if (!isIntent(message)) {
        console.warn(`[ws] session ${session.id} sent an invalid message - dropped`);
        return;
      }
      options.enqueueIntent(session.entityId, message);
    });

    session.socket.on('close', () => {
      world.despawn(session.entityId);
      sessions.delete(session.id);
      // Drop the session's snapshot diff state so a reconnect starts fresh.
      forgetSession(session.id);
      console.log(`[ws] session ${session.id} disconnected - despawned entity ${session.entityId}`);
    });

    session.socket.on('error', (err) => {
      console.warn(`[ws] session ${session.id} error: ${err.message}`);
    });
  });

  httpServer.listen(options.port, () => {
    console.log(`[ws] listening on ws://localhost:${options.port}`);
  });

  return {
    broadcast(
      buildPlayerSnapshot: (
        entityId: number,
        sessionId: string,
        view?: { x: number; y: number },
      ) => ServerMessage,
    ): void {
      for (const session of sessions.values()) {
        if (session.socket.readyState !== WebSocket.OPEN) continue;
        try {
          // Binary sessions get the compact wire format (~1/4 the size);
          // everyone else keeps JSON. Encoding can throw (a value outgrew
          // its uint16 field) — caught here so one bad session never kills
          // the broadcast loop.
          // Centre this session's snapshot on ITS camera, not its player:
          // the camera trails and can be panned, so the two differ.
          const view =
            session.viewX !== undefined && session.viewY !== undefined
              ? { x: session.viewX, y: session.viewY }
              : undefined;
          const snapshot = buildPlayerSnapshot(session.entityId, session.id, view);
          const data = session.useBinary ? encodeServerMessage(snapshot) : JSON.stringify(snapshot);
          options.onSnapshot?.(snapshot, data);
          session.socket.send(data);
        } catch (err) {
          console.warn(
            `[ws] snapshot build/encode failed for entity ${session.entityId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },
    sessionCount(): number {
      return sessions.size;
    },
    close(): void {
      for (const session of sessions.values()) {
        session.socket.close();
      }
      wss.close();
      httpServer.close();
    },
  };
}
