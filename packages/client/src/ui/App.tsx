import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Intent } from '@game/shared';
import type { Game } from '../game.ts';
import { DebugPanel } from './DebugPanel.tsx';
import { InventoryPanel } from './InventoryPanel.tsx';
import { RecipePanel } from './RecipePanel.tsx';

const POLL_MS = 200;

/**
 * A feature UI panel: a React component rendered into the overlay. The
 * zero-prop signature stays compatible — panels that ignore sendIntent just
 * don't take the prop — and panels that do take it can send intents (e.g.
 * test buttons for feature commands).
 */
export type FeaturePanel = (props: { sendIntent: (intent: Intent) => void }) => ReactElement;

/**
 * Red banner listing feature systems the server guard auto-disabled. Polls
 * the game state like the debug panel; the server reports disables via the
 * snapshot's disabledFeatures field.
 */
function FeatureBanner({ game }: { game: Game }) {
  const [disabled, setDisabled] = useState<string[]>([]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setDisabled([...game.state.disabledFeatures]);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [game]);

  if (disabled.length === 0) return null;
  return (
    <div className="feature-banner">
      {disabled.map((name) => (
        <div key={name}>
          FEATURE SYSTEM DISABLED: {name} — it will not run until the server restarts
        </div>
      ))}
    </div>
  );
}

/**
 * Root React component. Rendered into #ui-overlay, which sits above the
 * Pixi canvas. The shell is pointer-transparent (see index.html CSS) so
 * the canvas keeps every click that isn't on a panel; panels opt back in
 * with pointer-events: auto and stop their own events from propagating.
 * Feature panels are rendered by the client feature loader; the inventory
 * panel and debug panel are core.
 */
export function App({
  game,
  featurePanels,
  sendIntent,
}: {
  game: Game;
  featurePanels?: Record<string, FeaturePanel>;
  sendIntent: (intent: Intent) => void;
}) {
  return (
    <div className="overlay">
      {featurePanels && Object.keys(featurePanels).length > 0 && (
        <div className="feature-panels">
          {Object.entries(featurePanels).map(([id, Panel]) => (
            <Panel key={id} sendIntent={sendIntent} />
          ))}
        </div>
      )}
      <FeatureBanner game={game} />
      <InventoryPanel game={game} sendIntent={sendIntent} />
      <RecipePanel game={game} sendIntent={sendIntent} />
      <DebugPanel game={game} />
    </div>
  );
}
