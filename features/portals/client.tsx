import { useEffect } from 'react';
import { defineClient, type Intent } from '@game/shared';

/**
 * Portals: the pad glyphs, plus Space (or the button) to step through one.
 *
 * The key is bound here rather than in the client's keyboard handler because
 * core owns the keyboard and a feature must not have to edit it. A panel is
 * an ordinary React component, so it can listen on window itself — which
 * means a feature can add a keybinding without touching packages/*.
 *
 * Several features can bind the same key blindly: each command no-ops when
 * there is nothing of its own in reach, so Space next to a door enters the
 * door and Space next to a pad takes the portal, and neither feature knows
 * the other exists.
 */
function usePortalKey(sendIntent: (intent: Intent) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) return;
      // Events from inside the overlay belong to the panels — without this,
      // Space after clicking the button would re-activate the focused button
      // AND fire this handler, sending the intent twice.
      if (event.target instanceof Element && event.target.closest('#ui-overlay')) return;
      event.preventDefault(); // Space scrolls the page otherwise
      sendIntent({ t: 'intent', kind: 'portals:use' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sendIntent]);
}

function PortalPanel({ sendIntent }: { sendIntent: (intent: Intent) => void }) {
  usePortalKey(sendIntent);
  return (
    <div className="feature-panel">
      <div style={{ marginBottom: 4, opacity: 0.8 }}>Portals</div>
      <button
        onClick={(e) => {
          // Drop focus, or the button keeps eating Space afterwards.
          e.currentTarget.blur();
          sendIntent({ t: 'intent', kind: 'portals:use' });
        }}
      >
        🌀 Enter portal <span style={{ opacity: 0.6 }}>(Space)</span>
      </button>
    </div>
  );
}

export default defineClient({
  sprites: {
    'portals:pad': '🌀',
    'portals:return': '🏠',
  },
  panels: {
    'portals:panel': PortalPanel,
  },
});
