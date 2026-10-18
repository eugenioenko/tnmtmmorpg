import { useEffect } from 'react';
import { defineClient, type Intent } from '@game/shared';

/**
 * Doors, and Space (or the button) to use one. The same command works both
 * ways — outside it takes you in, inside it takes you back out — so one key
 * is the whole interface.
 *
 * Bound here rather than in core's keyboard handler: a panel is an ordinary
 * React component, so a feature can add a keybinding without touching
 * packages/*. Sharing Space with the portals feature is safe because each
 * command no-ops when nothing of its own is in reach.
 */
function useDoorKey(sendIntent: (intent: Intent) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) return;
      // Panels own keys pressed inside the overlay; skipping them stops a
      // focused button from firing the intent a second time.
      if (event.target instanceof Element && event.target.closest('#ui-overlay')) return;
      event.preventDefault();
      sendIntent({ t: 'intent', kind: 'buildings:enter' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sendIntent]);
}

function DoorPanel({ sendIntent }: { sendIntent: (intent: Intent) => void }) {
  useDoorKey(sendIntent);
  return (
    <div className="feature-panel">
      <div style={{ marginBottom: 4, opacity: 0.8 }}>Buildings</div>
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          sendIntent({ t: 'intent', kind: 'buildings:enter' });
        }}
      >
        🚪 Use door <span style={{ opacity: 0.6 }}>(Space)</span>
      </button>
    </div>
  );
}

export default defineClient({
  sprites: {
    'buildings:door': '🚪',
    'buildings:exit': '🪜',
    'buildings:prop': '🪵',
  },
  panels: {
    'buildings:panel': DoorPanel,
  },
});
