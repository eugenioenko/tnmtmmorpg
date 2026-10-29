import { useEffect, useReducer } from 'react';
import { defineClient, type ClientAPI } from '@game/shared';
import { ITEMS, type DungeonStatus } from './index.ts';
import './dungeons.css';

function useStatus(client: ClientAPI): DungeonStatus | undefined {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  const raw = client.localPlayer()?.components['dungeons:status'];
  return typeof raw === 'object' && raw !== null ? (raw as DungeonStatus) : undefined;
}

/** What this run is about, in the right-hand column while underground. */
function DungeonTracker({ client }: { client: ClientAPI }) {
  const s = useStatus(client);
  if (!s) return null;
  return (
    <div className="frame dungeon-tracker">
      <div className="dungeon-title">
        {s.cave}
        <span className="dungeon-level">Lv {s.level}</span>
      </div>
      <div className={`dungeon-goal${s.cleared ? ' done' : ''}`}>
        {s.cleared ? '✓' : '☠'} Defeat {s.guardian || 'the guardian'}
      </div>
      <div className={`dungeon-goal${s.looted ? ' done' : ''}`}>
        {s.looted ? '✓' : '◇'} Claim the hoard
      </div>
      <div className="dungeon-copy">Copy #{s.copy} · the ladder by the entrance leads out</div>
    </div>
  );
}

/** Caves are dark: only torches, crystals and your own faint glow show the way. */
function CaveGloom({ client }: { client: ClientAPI }) {
  const s = useStatus(client);
  const lit = s?.lit ?? false;
  useEffect(() => client.setDarkness('dungeons', s ? (lit ? 0.8 : 0.94) : 0, 0x050308), [client, s, lit]);
  useEffect(() => () => client.setDarkness('dungeons', 0), [client]);
  return null;
}

export default defineClient({
  items: ITEMS,
  sprites: {
    'dungeons:entrance': '🕳️',
    'dungeons:exit': '🪜',
    'dungeons:chest': '🧰',
  },
  interactions: {
    'dungeons:entrance': { intent: 'dungeons:enter', label: 'Enter' },
    'dungeons:exit': { intent: 'dungeons:leave', label: 'Climb out of' },
    'dungeons:chest': { intent: 'dungeons:open', label: 'Open' },
  },
  hud: { 'dungeons:tracker': DungeonTracker },
  overlay: { 'dungeons:gloom': CaveGloom },
});
