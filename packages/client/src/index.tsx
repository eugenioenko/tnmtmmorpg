import { createRoot } from 'react-dom/client';
import {
  decodeServerMessage,
  defineClient,
  type DeltaSnapshot,
  type Direction,
  type FullSnapshot,
  type Intent,
  type ItemDef,
  type RecipesMessage,
  type WelcomeMessage,
} from '@game/shared';
import { registerEmoji } from './emoji-atlas.ts';
import { createGame, type Game } from './game.ts';
import { registerItems } from './items.ts';
import { registerRecipes } from './recipes.ts';
import { App, type FeaturePanel } from './ui/App.tsx';
import { INVENTORY_TOGGLE_EVENT } from './ui/InventoryPanel.tsx';

const WS_URL = (import.meta.env?.VITE_WS_URL as string | undefined) ?? 'ws://localhost:3010';
const RECONNECT_DELAY_MS = 1000;
const PING_INTERVAL_MS = 2000;

interface Pong {
  t: 'pong';
  ts: number;
}

/** Arrow keys: ordinary one-tile steps. */
const ARROW_TO_DIR: Record<string, Direction> = {
  ArrowUp: 'n',
  ArrowDown: 's',
  ArrowRight: 'e',
  ArrowLeft: 'w',
};

/** WASD: long strides, for crossing a 10000x10000 world on foot. */
const WASD_TO_DIR: Record<string, Direction> = {
  w: 'n',
  s: 's',
  d: 'e',
  a: 'w',
  W: 'n',
  S: 's',
  D: 'e',
  A: 'w',
};

/** Tiles per WASD press. The server caps this at MAX_MOVE_DIST. */
const STRIDE = 100;

/**
 * IJKL pans the camera without moving the player — the view is not welded
 * to the character. The range is clamped to the margin the server sends
 * beyond the visible area, so free-look can never show ground the client
 * was not given. 'o' snaps the view back onto the player.
 */
const PAN_KEYS: Record<string, { x: number; y: number }> = {
  i: { x: 0, y: -1 },
  k: { x: 0, y: 1 },
  j: { x: -1, y: 0 },
  l: { x: 1, y: 0 },
  I: { x: 0, y: -1 },
  K: { x: 0, y: 1 },
  J: { x: -1, y: 0 },
  L: { x: 1, y: 0 },
};

/** World pixels per pan keypress. */
const PAN_STEP = 64;

function isFullSnapshot(value: unknown): value is FullSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return (
    msg.t === 'full' &&
    typeof msg.tick === 'number' &&
    Array.isArray(msg.entities) &&
    Array.isArray(msg.tiles) &&
    typeof msg.playerX === 'number' &&
    typeof msg.playerY === 'number'
  );
}

function isDeltaSnapshot(value: unknown): value is DeltaSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return (
    msg.t === 'delta' &&
    typeof msg.tick === 'number' &&
    Array.isArray(msg.entities) &&
    Array.isArray(msg.removedEntities) &&
    Array.isArray(msg.tiles) &&
    Array.isArray(msg.removedTiles) &&
    typeof msg.playerX === 'number' &&
    typeof msg.playerY === 'number'
  );
}

function isWelcome(value: unknown): value is WelcomeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return msg.t === 'welcome' && typeof msg.entityId === 'number' && typeof msg.color === 'string';
}

function isPong(value: unknown): value is Pong {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return msg.t === 'pong' && typeof msg.ts === 'number';
}

function isRecipesMessage(value: unknown): value is RecipesMessage {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return msg.t === 'recipes' && Array.isArray(msg.recipes);
}

/** Feature systems the server guard auto-disabled, or [] when none. */
function readDisabledFeatures(msg: { disabledFeatures?: unknown }): string[] {
  return Array.isArray(msg.disabledFeatures)
    ? msg.disabledFeatures.filter((name): name is string => typeof name === 'string')
    : [];
}

/** True when the event originated inside the UI overlay — panels own those keys/clicks. */
function originatesInOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('#ui-overlay') !== null;
}

/**
 * Feature discovery on the client: every features/<name>/client.tsx is
 * loaded eagerly at boot (Vite resolves the glob relative to this file).
 * Each module's default export is a defineClient plugin — its items are
 * registered for the inventory panel, its panels are rendered into the
 * overlay and its sprites map entity kinds to emoji glyphs. Adding a
 * feature requires no changes in core client code.
 */
const featureModules = import.meta.glob('../../../features/*/client.tsx', { eager: true });

/** Register every loaded feature's items, panels and sprites; returns the panels. */
function loadFeaturePanels(): Record<string, FeaturePanel> {
  const panels: Record<string, FeaturePanel> = {};
  for (const path of Object.keys(featureModules)) {
    const mod = featureModules[path] as { default?: unknown };
    const plugin = defineClient(mod.default ?? mod) as {
      items?: ItemDef[];
      panels?: Record<string, unknown>;
      sprites?: Record<string, string>;
    };
    if (typeof plugin !== 'object' || plugin === null) {
      console.error(`[client] ${path}: default export is not a defineClient plugin - skipping`);
      continue;
    }
    if (plugin.items && typeof plugin.items === 'object') {
      if (Array.isArray(plugin.items)) registerItems(plugin.items);
      else console.error(`[client] ${path}: items must be an array - skipping`);
    }
    if (plugin.panels && typeof plugin.panels === 'object') {
      for (const [id, panel] of Object.entries(plugin.panels)) {
        if (typeof panel !== 'function') {
          console.error(`[client] ${path}: panel '${id}' is not a component - skipping`);
          continue;
        }
        panels[id] = panel as FeaturePanel;
      }
    }
    if (plugin.sprites && typeof plugin.sprites === 'object') {
      for (const [kind, glyph] of Object.entries(plugin.sprites)) {
        registerEmoji(kind, glyph);
      }
    }
  }
  return panels;
}

async function main(): Promise<void> {
  // Feature panels discovered via import.meta.glob; loaded before React mounts.
  const featurePanels = loadFeaturePanels();

  let socket: WebSocket | null = null;
  let game: Game = null!;
  const pending: unknown[] = [];

  // Connect first so data arrives while PixiJS initialises.
  connect();

  // Pixi canvas + game layer (60fps render loop, snapshot interpolation).
  game = await createGame();
  game.state.connected = true;

  // Replay any early messages that arrived while PixiJS was initialising
  while (pending.length > 0) {
    const msg = pending.shift()! as Record<string, unknown>;
    if (isWelcome(msg)) {
      game.setLocalEntity(msg.entityId);
      applyViewLimits(msg);
    } else if (isRecipesMessage(msg)) {
      registerRecipes(msg.recipes);
    } else if (isFullSnapshot(msg)) {
      game.pushSnapshot(msg);
      game.state.disabledFeatures = readDisabledFeatures(msg);
    } else if (isDeltaSnapshot(msg)) {
      game.pushSnapshot(msg);
      game.state.disabledFeatures = readDisabledFeatures(msg);
    }
  }

  /** The server declares how much world it sends; cap the canvas to it. */
  function applyViewLimits(msg: WelcomeMessage): void {
    if (
      typeof msg.viewRadiusX === 'number' &&
      typeof msg.viewRadiusY === 'number' &&
      typeof msg.tileSize === 'number'
    ) {
      game.setViewLimits(msg.viewRadiusX, msg.viewRadiusY, msg.tileSize);
    }
  }

  function sendIntent(intent: Intent): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(intent));
    }
  }

  // Clicking an entity attacks it. 'combat:attack' is a FEATURE command, not
  // a core intent — with the combat feature uninstalled the server simply
  // rejects the kind. Damage and adjacency are validated server-side there.
  game.setAttackHandler((entityId) => {
    sendIntent({ t: 'intent', kind: 'combat:attack', targetId: entityId });
  });

  function connect(): void {
    const ws = new WebSocket(WS_URL);
    socket = ws;
    // Binary frames arrive as ArrayBuffers, not Blobs, so the handler below
    // can decode them directly.
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      if (game) game.state.connected = true;
      ws.send(JSON.stringify({ t: 'binary', enabled: true }));
    });

    ws.addEventListener('message', (event) => {
      let message: unknown;
      if (event.data instanceof ArrayBuffer) {
        // Binary frames: snapshots and pongs, decoded with the shared codec.
        try {
          message = decodeServerMessage(new Uint8Array(event.data));
        } catch {
          return; // malformed binary frame; ignore
        }
      } else {
        // Text frames: the welcome, the recipe registry, and anything from
        // a server that never switched us to binary.
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return; // malformed frame; ignore
        }
      }
      if (typeof message !== 'object' || message === null) return;

      const msg = message as Record<string, unknown>;
      // Buffer everything until PixiJS is ready; pongs before then are stale.
      if (!game) {
        if (!isPong(msg)) pending.push(msg);
        return;
      }

      if (isPong(msg)) {
        game.state.pingMs = ~~(performance.now() - msg.ts);
      } else if (isWelcome(msg)) {
        game.setLocalEntity(msg.entityId);
      } else if (isRecipesMessage(msg)) {
        registerRecipes(msg.recipes);
      } else if (isFullSnapshot(msg)) {
        game.pushSnapshot(msg);
        game.state.disabledFeatures = readDisabledFeatures(msg);
      } else if (isDeltaSnapshot(msg)) {
        game.pushSnapshot(msg);
        game.state.disabledFeatures = readDisabledFeatures(msg);
      }
    });

    ws.addEventListener('close', () => {
      if (game) {
        game.state.connected = false;
        game.setLocalEntity(null);
      }
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  /**
   * Tell the server where the camera is looking, whenever that tile changes.
   * The camera trails the player and can be panned with free-look, so the
   * server cannot infer the view from the entity's position — without this
   * it sends tiles centred on the player and the client renders ground it
   * was never given (which falls back to grass, then snaps: the edge
   * flicker). Only fires on change, so a stationary camera costs nothing.
   */
  function startViewReports(): void {
    let lastX: number | null = null;
    let lastY: number | null = null;
    window.setInterval(() => {
      if (!game || !socket || socket.readyState !== WebSocket.OPEN) return;
      const { x, y } = game.viewTile();
      if (x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;
      socket.send(JSON.stringify({ t: 'view', x, y }));
    }, 50);
  }

  function startPing(): void {
    window.setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
      }
    }, PING_INTERVAL_MS);
  }

  // React overlay mounted above the canvas.
  const overlay = document.getElementById('ui-overlay');
  if (overlay) {
    createRoot(overlay).render(
      <App game={game} featurePanels={featurePanels} sendIntent={sendIntent} />,
    );
  }

  // Keyboard input. Events that bubble up from the UI overlay are ignored so
  // panels can own their own keys; arrow keys / WASD move, 'I' toggles the
  // inventory panel.
  window.addEventListener('keydown', (event) => {
    if (originatesInOverlay(event.target)) return;
    if (event.key === 'i' || event.key === 'I') {
      window.dispatchEvent(new Event(INVENTORY_TOGGLE_EVENT));
      return;
    }
    // Free-look first: these never reach the movement handler.
    const pan = PAN_KEYS[event.key];
    if (pan) {
      event.preventDefault();
      game.panCamera(pan.x * PAN_STEP, pan.y * PAN_STEP);
      return;
    }
    if (event.key === 'o' || event.key === 'O') {
      event.preventDefault();
      game.recentreCamera();
      return;
    }

    const step = ARROW_TO_DIR[event.key];
    if (step) {
      event.preventDefault();
      sendIntent({ t: 'intent', kind: 'move', dir: step });
      return;
    }
    const stride = WASD_TO_DIR[event.key];
    if (stride) {
      event.preventDefault();
      sendIntent({ t: 'intent', kind: 'move', dir: stride, dist: STRIDE });
    }
  });

  startPing();
  startViewReports();
}

main();
