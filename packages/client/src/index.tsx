import { createRoot } from 'react-dom/client';
import {
  decodeServerMessage,
  defineClient,
  type ClientWindow,
  type DeltaSnapshot,
  type FullSnapshot,
  type Intent,
  type Interaction,
  type InventoryComponent,
  type ItemDef,
  type RecipesMessage,
  type WelcomeMessage,
} from '@game/shared';
import { registerEmoji } from './emoji-atlas.ts';
import { createGame, type Game } from './game.ts';
import { registerItems } from './items.ts';
import { registerRecipes } from './recipes.ts';
import { registerInteractions, setCarryCheck } from './interactions.ts';
import { Controls } from './controls.ts';
import { App, registerCoreWindows, type FeatureComponent, type FeaturePanel } from './ui/App.tsx';
import { HudRuntime } from './ui/runtime.ts';

const WS_URL = (import.meta.env?.VITE_WS_URL as string | undefined) ?? 'ws://localhost:3010';
const RECONNECT_DELAY_MS = 1000;
const PING_INTERVAL_MS = 2000;

interface Pong {
  t: 'pong';
  ts: number;
}

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

/**
 * Feature discovery on the client: every features/<name>/client.tsx is
 * loaded eagerly at boot (Vite resolves the glob relative to this file).
 * Each module's default export is a defineClient plugin — its items are
 * registered for the inventory panel, its panels are rendered into the
 * overlay and its sprites map entity kinds to emoji glyphs. Adding a
 * feature requires no changes in core client code.
 */
const featureModules = import.meta.glob('../../../features/*/client.tsx', { eager: true });

interface LoadedFeatures {
  devPanels: Record<string, FeaturePanel>;
  windows: Record<string, ClientWindow>;
  hud: Record<string, FeatureComponent>;
  overlays: Record<string, FeatureComponent>;
}

/** Register every loaded feature's items, sprites and interactions; collect its UI. */
function loadFeatures(): LoadedFeatures {
  const loaded: LoadedFeatures = { devPanels: {}, windows: {}, hud: {}, overlays: {} };
  for (const path of Object.keys(featureModules)) {
    const mod = featureModules[path] as { default?: unknown };
    const plugin = defineClient(mod.default ?? mod) as {
      items?: ItemDef[];
      panels?: Record<string, unknown>;
      sprites?: Record<string, string>;
      interactions?: Record<string, Interaction>;
      windows?: Record<string, ClientWindow>;
      hud?: Record<string, unknown>;
      overlay?: Record<string, unknown>;
    };
    if (typeof plugin !== 'object' || plugin === null) {
      console.error(`[client] ${path}: default export is not a defineClient plugin - skipping`);
      continue;
    }
    if (plugin.items && typeof plugin.items === 'object') {
      if (Array.isArray(plugin.items)) registerItems(plugin.items);
      else console.error(`[client] ${path}: items must be an array - skipping`);
    }
    for (const [id, panel] of Object.entries(plugin.panels ?? {})) {
      if (typeof panel !== 'function') {
        console.error(`[client] ${path}: panel '${id}' is not a component - skipping`);
        continue;
      }
      loaded.devPanels[id] = panel as FeaturePanel;
    }
    for (const [kind, glyph] of Object.entries(plugin.sprites ?? {})) registerEmoji(kind, glyph);
    if (plugin.interactions) registerInteractions(plugin.interactions);
    for (const [id, win] of Object.entries(plugin.windows ?? {})) {
      if (typeof win?.component !== 'function') {
        console.error(`[client] ${path}: window '${id}' has no component - skipping`);
        continue;
      }
      loaded.windows[id] = win;
    }
    for (const [id, widget] of Object.entries(plugin.hud ?? {})) {
      if (typeof widget === 'function') loaded.hud[id] = widget as FeatureComponent;
    }
    for (const [id, layer] of Object.entries(plugin.overlay ?? {})) {
      if (typeof layer === 'function') loaded.overlays[id] = layer as FeatureComponent;
    }
  }
  return loaded;
}

async function main(): Promise<void> {
  // Feature UI discovered via import.meta.glob; loaded before React mounts.
  const features = loadFeatures();

  let socket: WebSocket | null = null;
  let game: Game = null!;
  const pending: unknown[] = [];

  // Connect first so data arrives while PixiJS initialises.
  connect();

  // Pixi canvas + game layer (60fps render loop, snapshot interpolation).
  game = await createGame();
  game.state.connected = true;
  setCarryCheck((itemId) => {
    const inv = game.localPlayer()?.components.inventory as InventoryComponent | undefined;
    return inv?.slots?.some((s) => s.itemId === itemId && s.count > 0) ?? false;
  });

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
        } catch (err) {
          // Say so. Swallowing this silently means a snapshot the client
          // cannot read looks exactly like a server that stopped sending —
          // the screen simply stops updating with nothing to explain it.
          console.error('[client] could not decode a binary frame:', err);
          return;
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

  // Input and HUD. Clicking a creature attacks it through 'combat:attack', a
  // FEATURE command: with combat uninstalled the server rejects the kind.
  let hud: HudRuntime | null = null;
  const controls = new Controls(
    game,
    sendIntent,
    (text) => hud?.notify(text, 'bad'),
    (id) => hud?.toggle(id, true),
  );
  hud = new HudRuntime(game, controls, sendIntent);
  registerCoreWindows(hud);
  for (const [id, win] of Object.entries(features.windows)) hud.windows.set(id, { ...win, id });
  const overlay = document.getElementById('ui-overlay');
  if (overlay) {
    createRoot(overlay).render(
      <App
        rt={hud}
        devPanels={features.devPanels}
        hudWidgets={features.hud}
        overlays={features.overlays}
      />,
    );
  }
  hud.notify('Welcome to the realm. Click to walk, click creatures to fight, Enter to chat.', 'info');
  if (import.meta.env?.DEV) Object.assign(window, { __game: game, __hud: hud });

  startPing();
  startViewReports();
}

main();
