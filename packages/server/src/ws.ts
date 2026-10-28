import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import {
  emptySlots,
  encodeServerMessage,
  INVENTORY_CAPACITY,
  isStatsComponent,
  OVERWORLD,
  TILE_SIZE,
  VISIBLE_RADIUS_X,
  VISIBLE_RADIUS_Y,
  type AccountMessage,
  type DeniedMessage,
  type Intent,
  type PlayerEnterEvent,
  type Pong,
  type RecipeDef,
  type RecipesMessage,
  type ServerMessage,
  type WelcomeMessage,
  type WorldCoord,
} from '@game/shared';
import type { World } from './world.ts';
import { forgetSession } from './snapshot.ts';
import {
  cleanName,
  cleanTraits,
  createCharacter,
  deleteCharacter,
  getCharacter,
  listCharacters,
  MAX_CHARACTERS,
  saveCharacter,
  type Verify,
} from './characters.ts';

/**
 * How a connection proves who it is:
 * - oidc: an access token from the identity provider (production).
 * - dev:  a browser-local id, trusted as-is. For local play without an IdP.
 * - off:  no accounts; every connection spawns a throwaway player at once.
 *         The integration tests run this way.
 */
export type AuthMode = { kind: 'oidc'; verify: Verify } | { kind: 'dev' } | { kind: 'off' };

/** Saved with every character regardless of features: core owns these. */
const CORE_PERSISTED = ['inventory', 'stats'];
const SAVE_INTERVAL_MS = 10_000;

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
  db: DatabaseSync;
  auth: AuthMode;
  /** Player components that features ask to keep across logouts. */
  persistComponents: ReadonlySet<string>;
  /** A character entered the world; core forwards it to features as 'player:enter'. */
  onEnter: (event: PlayerEnterEvent) => void;
}

interface Session {
  id: string;
  socket: WebSocket;
  /** The player entity, while a character is in the world. */
  entityId?: number;
  color: string;
  account?: string;
  authing?: boolean;
  characterId?: string;
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
// Start beside the central portal plaza, with its exits and village in sight.
const SPAWN_AREA = 6;

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

  const { db, auth } = options;
  const persisted = [...CORE_PERSISTED, ...options.persistComponents];

  function send(session: Session, message: unknown): void {
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
  }

  function sendAccount(session: Session, error?: string): void {
    if (!session.account) return;
    send(session, {
      t: 'account',
      characters: listCharacters(db, session.account),
      maxCharacters: MAX_CHARACTERS,
      ...(error ? { error } : {}),
    } satisfies AccountMessage);
  }

  function spawnPlayer(session: Session, pos: WorldCoord, components: Record<string, unknown>, worldId: string): void {
    // Phase 5: every player spawns with a fixed-size inventory.
    // Phase 7: and with a stats component — hp/atk/def, which the client's
    // health bar reads and feature-side damage rules act on.
    session.entityId = world.spawn(
      'player',
      pos,
      {
        inventory: { slots: emptySlots(INVENTORY_CAPACITY), capacity: INVENTORY_CAPACITY },
        stats: { hp: 100, maxHp: 100, atk: 15, def: 5, level: 1 },
        ...components,
        player: { color: session.color },
      },
      worldId,
    );
    send(session, {
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
    } satisfies WelcomeMessage);
    // Phase 6: recipes are immutable at runtime, so one push per entry is
    // enough — the client renders the recipe browser from this registry.
    send(session, { t: 'recipes', recipes: options.recipes } satisfies RecipesMessage);
  }

  /** Write the character's persisted components and position back to its row. */
  function save(session: Session): void {
    if (!session.characterId || session.entityId === undefined) return;
    const e = world.get(session.entityId);
    if (!e) return;
    const components: Record<string, unknown> = {};
    for (const name of persisted) if (name in e.components) components[name] = e.components[name];
    const stats = e.components.stats;
    const level = isStatsComponent(stats) ? stats.level : 1;
    saveCharacter(db, session.characterId, level, { x: e.x, y: e.y, world: e.world, components });
  }

  /** Save and remove the character from the world; the session stays connected. */
  function leave(session: Session): void {
    if (session.entityId === undefined) return;
    save(session);
    world.despawn(session.entityId);
    forgetSession(session.id);
    console.log(`[ws] session ${session.id} left the world - despawned entity ${session.entityId}`);
    session.entityId = undefined;
    session.characterId = undefined;
    session.viewX = undefined;
    session.viewY = undefined;
  }

  function play(session: Session, characterId: unknown): void {
    if (!session.account || typeof characterId !== 'string') return;
    const row = getCharacter(db, characterId);
    if (!row || row.account !== session.account) return sendAccount(session, 'That character is not yours.');
    for (const other of sessions.values()) {
      if (other !== session && other.characterId === row.id) {
        leave(other);
        send(other, {
          t: 'denied',
          reason: 'replaced',
          message: `${row.name} was opened somewhere else.`,
        } satisfies DeniedMessage);
        other.socket.close(4001, 'replaced');
      }
    }
    leave(session);
    const state = row.state;
    const restore =
      state && state.world === OVERWORLD && world.isWalkable(state.x, state.y)
        ? { x: state.x, y: state.y }
        : findSpawn(world);
    session.characterId = row.id;
    spawnPlayer(session, restore, state?.components ?? {}, OVERWORLD);
    options.onEnter({
      entityId: session.entityId!,
      name: row.name,
      created: state === undefined,
      traits: row.traits,
    });
    save(session);
    console.log(`[ws] session ${session.id} entered as ${row.name} (entity ${session.entityId})`);
  }

  async function authenticate(session: Session, message: Record<string, unknown>): Promise<void> {
    if (session.account || session.authing) return;
    session.authing = true;
    try {
      if (auth.kind === 'oidc') {
        if (typeof message.token !== 'string') throw new Error('no token');
        session.account = await auth.verify(message.token);
      } else if (typeof message.dev === 'string' && /^[a-z0-9-]{8,64}$/.test(message.dev)) {
        session.account = `dev:${message.dev}`;
      } else {
        throw new Error('no dev id');
      }
    } catch (err) {
      console.warn(`[ws] session ${session.id} failed to authenticate: ${err instanceof Error ? err.message : String(err)}`);
      send(session, { t: 'denied', reason: 'auth', message: 'Your sign-in was not accepted.' } satisfies DeniedMessage);
      session.socket.close(4000, 'auth');
      return;
    } finally {
      session.authing = false;
    }
    console.log(`[ws] session ${session.id} authenticated as ${session.account}`);
    sendAccount(session);
  }

  function handleAccount(session: Session, message: Record<string, unknown>): void {
    if (!session.account) return;
    switch (message.t) {
      case 'char:create': {
        if (session.entityId !== undefined) return;
        const name = cleanName(message.name);
        if (!name) return sendAccount(session, 'Names are 3 to 16 letters; spaces, hyphens and apostrophes are fine inside.');
        const result = createCharacter(db, session.account, name, cleanTraits(message.traits));
        return sendAccount(session, result.ok ? undefined : result.error);
      }
      case 'char:delete':
        if (session.entityId !== undefined || typeof message.id !== 'string') return;
        if ([...sessions.values()].some((s) => s.characterId === message.id)) {
          return sendAccount(session, 'That character is in the world right now.');
        }
        deleteCharacter(db, session.account, message.id);
        return sendAccount(session);
      case 'char:play':
        return play(session, message.id);
      case 'char:leave':
        leave(session);
        return sendAccount(session);
    }
  }

  const autosave = setInterval(() => {
    for (const session of sessions.values()) save(session);
  }, SAVE_INTERVAL_MS);

  wss.on('connection', (socket) => {
    const id = randomUUID();
    const color = PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length];
    const session: Session = { id, socket, color, useBinary: false };
    sessions.set(session.id, session);

    if (auth.kind === 'off') {
      const pos = findSpawn(world);
      spawnPlayer(session, pos, {}, OVERWORLD);
      console.log(`[ws] session ${session.id} connected as entity ${session.entityId} at (${pos.x}, ${pos.y})`);
    } else {
      console.log(`[ws] session ${session.id} connected - waiting for sign-in`);
    }

    session.socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        console.warn(`[ws] session ${session.id} sent non-JSON data - dropped`);
        return;
      }
      if (typeof message === 'object' && message !== null) {
        const msg = message as Record<string, unknown>;
        if (msg.t === 'auth') {
          if (auth.kind !== 'off') void authenticate(session, msg);
          return;
        }
        if (typeof msg.t === 'string' && msg.t.startsWith('char:')) {
          handleAccount(session, msg);
          return;
        }
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
      if (session.entityId !== undefined) options.enqueueIntent(session.entityId, message);
    });

    session.socket.on('close', () => {
      // Drops the session's snapshot diff state too, so a reconnect starts fresh.
      leave(session);
      sessions.delete(session.id);
      console.log(`[ws] session ${session.id} disconnected`);
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
        if (session.entityId === undefined || session.socket.readyState !== WebSocket.OPEN) continue;
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
      clearInterval(autosave);
      for (const session of sessions.values()) {
        leave(session);
        session.socket.close();
      }
      wss.close();
      httpServer.close();
    },
  };
}
