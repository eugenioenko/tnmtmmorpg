import { useEffect, useState } from 'react';
import type { Game, GameState } from '../game.ts';

const POLL_MS = 200;

/**
 * Debug overlay panel: tick, ping, entity count, FPS. Sits in the top-right
 * corner above the canvas. It polls the game instance rather than driving
 * React from the render loop, so the 60fps loop never re-renders UI.
 * Pointer and key events are stopped here so they never reach the game's
 * window-level input handlers.
 */
export function DebugPanel({ game }: { game: Game }) {
  const [state, setState] = useState<GameState>(() => ({ ...game.state }));
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const id = window.setInterval(() => {
      setState({ ...game.state });
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [game]);

  return (
    <div
      className="debug-panel"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="debug-toggle"
        aria-label={open ? 'hide debug panel' : 'show debug panel'}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '–' : '+'}
      </button>
      {open && (
        <div className="debug-rows">
          <div>
            pos: {state.playerX}, {state.playerY}
          </div>
          <div>world: {state.world}</div>
          <div>tick: {state.tick}</div>
          <div>ping: {state.pingMs} ms</div>
          <div>entities: {state.entityCount}</div>
          <div>fps: {state.fps}</div>
          <div className={state.connected ? 'conn-on' : 'conn-off'}>
            {state.connected ? 'connected' : 'disconnected'}
          </div>
        </div>
      )}
    </div>
  );
}
