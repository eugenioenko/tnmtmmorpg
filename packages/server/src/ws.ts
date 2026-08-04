import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  emptySlots,
  INVENTORY_CAPACITY,
  type Intent,
  type Pong,
  type RecipeDef,
  type RecipesMessage,
  type ServerMessage,
  type WorldCoord,
} from '@game/shared';
import type { World } from './world.ts';

export interface WsServer {
  /** Send a snapshot to every connected session. */
  broadcast(message: ServerMessage): void;
  close(): void;
}

export interface WsServerOptions {
  port: number;
  /** Route an intent from a session to the tick loop's intent queue. */
  enqueueIntent: (entityId: number, intent: Intent) => void;
  /** Phase 6: the recipe registry, pushed to each client on connect. */
  recipes: RecipeDef[];
}

interface Session {
  id: string;
  socket: WebSocket;
  entityId: number;
  color: string;
}

/** Sent once on connect so the client can identify its own entity. */
interface Welcome {
  t: 'welcome';
  entityId: number;
  color: string;
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
function isPing(value: unknown): value is { t: 'ping'; ts: number } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.t === 'ping' && typeof obj.ts === 'number';
}

/** A random walkable tile not already occupied by another player. */
function findSpawn(world: World): WorldCoord {
  const players = world.query('player');
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = 1 + ~~(world.rng() * (world.width - 2));
    const y = 1 + ~~(world.rng() * (world.height - 2));
    const free = !players.some((p) => p.x === x && p.y === y);
    if (free && world.isWalkable(x, y)) return { x, y };
  }
  return { x: 1, y: 1 }; // last resort; the corner inside the walls
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
    const entityId = world.spawn('player', pos, {
      player: { color },
      inventory: { slots: emptySlots(INVENTORY_CAPACITY), capacity: INVENTORY_CAPACITY },
    });

    const session: Session = { id, socket, entityId, color };
    sessions.set(session.id, session);

    session.socket.send(
      JSON.stringify({
        t: 'welcome',
        entityId: session.entityId,
        color: session.color,
      } satisfies Welcome),
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
      if (isPing(message)) {
        session.socket.send(JSON.stringify({ t: 'pong', ts: message.ts } satisfies Pong));
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
    broadcast(message: ServerMessage): void {
      const data = JSON.stringify(message);
      for (const session of sessions.values()) {
        if (session.socket.readyState === WebSocket.OPEN) {
          session.socket.send(data);
        }
      }
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
