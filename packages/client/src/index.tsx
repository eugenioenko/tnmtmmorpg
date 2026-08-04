import { createRoot } from 'react-dom/client';
import {
  defineClient,
  type Direction,
  type Intent,
  type ItemDef,
  type RecipesMessage,
  type Snapshot,
} from '@game/shared';
import { registerEmoji } from './emoji-atlas.ts';
import { createGame, type Game } from './game.ts';
import { registerItems } from './items.ts';
import { registerRecipes } from './recipes.ts';
import { App, type FeaturePanel } from './ui/App.tsx';
import { INVENTORY_TOGGLE_EVENT } from './ui/InventoryPanel.tsx';

const WS_URL = (import.meta.env?.VITE_WS_URL as string | undefined) ?? 'ws://localhost:3000';
const RECONNECT_DELAY_MS = 1000;
const PING_INTERVAL_MS = 2000;

interface Welcome {
  t: 'welcome';
  entityId: number;
  color: string;
}

interface Pong {
  t: 'pong';
  ts: number;
}

const KEY_TO_DIR: Record<string, Direction> = {
  ArrowUp: 'n',
  ArrowDown: 's',
  ArrowRight: 'e',
  ArrowLeft: 'w',
  w: 'n',
  s: 's',
  d: 'e',
  a: 'w',
};

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return (
    msg.t === 'snapshot' &&
    typeof msg.tick === 'number' &&
    Array.isArray(msg.entities) &&
    Array.isArray(msg.tiles)
  );
}

function isWelcome(value: unknown): value is Welcome {
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
  // Pixi canvas + game layer (60fps render loop, snapshot interpolation).
  const game: Game = await createGame();

  // Feature panels discovered via import.meta.glob; loaded before React mounts.
  const featurePanels = loadFeaturePanels();

  let socket: WebSocket | null = null;

  function sendIntent(intent: Intent): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(intent));
    }
  }

  function connect(): void {
    game.state.connected = false;
    socket = new WebSocket(WS_URL);

    socket.addEventListener('open', () => {
      game.state.connected = true;
    });

    socket.addEventListener('message', (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return; // malformed frame; ignore
      }
      if (typeof message !== 'object' || message === null) return;

      const msg = message as Record<string, unknown>;
      if (isWelcome(msg)) {
        game.setLocalEntity(msg.entityId);
      } else if (isRecipesMessage(msg)) {
        // Phase 6: the recipe registry powers the recipe browser panel.
        registerRecipes(msg.recipes);
      } else if (isPong(msg)) {
        game.state.pingMs = ~~(performance.now() - msg.ts);
      } else if (isSnapshot(msg)) {
        game.pushSnapshot(msg);
        game.state.disabledFeatures = Array.isArray(msg.disabledFeatures)
          ? msg.disabledFeatures.filter((name): name is string => typeof name === 'string')
          : [];
      }
    });

    socket.addEventListener('close', () => {
      game.state.connected = false;
      game.setLocalEntity(null);
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
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
    const dir = KEY_TO_DIR[event.key];
    if (!dir) return;
    event.preventDefault();
    sendIntent({ t: 'intent', kind: 'move', dir });
  });

  connect();
  startPing();
}

main();
