import { useEffect, useReducer } from 'react';
import { defineClient, type ClientAPI } from '@game/shared';
import { HERBS, ITEMS, type HerbSkill } from './index.ts';
import './herbalism.css';

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

/** The herbalist's field guide: your skill, and where every herb grows. */
function Guide({ client }: { client: ClientAPI }) {
  useLive(client);
  const raw = client.localPlayer()?.components['herbalism:skill'] as HerbSkill | undefined;
  const skill = raw ?? { level: 1, xp: 0, prev: 0, next: 30 };
  const span = skill.next - skill.prev;
  const pct = span > 0 ? ((skill.xp - skill.prev) / span) * 100 : 100;
  return (
    <div className="herb-guide">
      <div className="herb-skill">
        <span className="herb-skill-name">🌿 Herbalism</span>
        <span className="herb-skill-level">Lv {skill.level}</span>
      </div>
      <div className="herb-track">
        <div className="herb-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="herb-note">
        {skill.xp - skill.prev} / {span} XP · no tools needed, just a free hand
      </div>
      <div className="herb-list">
        {HERBS.map((h) => {
          const locked = skill.level < h.level;
          return (
            <div key={h.id} className={`herb-row${locked ? ' locked' : ''}`}>
              <span className="herb-icon">{h.icon}</span>
              <span className="herb-body">
                <b>{h.name}</b>
                <span className="herb-where">{h.where}</span>
              </span>
              <span className="herb-lv">{locked ? `Lv ${h.level}` : '✓'}</span>
            </div>
          );
        })}
      </div>
      <div className="herb-note">
        Brew at the <b>Cauldron</b> 🫕 beside the Alchemist’s house: healing draughts, Night Eye and
        Mana Tonic.
      </div>
    </div>
  );
}

export default defineClient({
  items: ITEMS,
  sprites: { 'herbalism:plant': '🌼', 'herbalism:cauldron': '🫕' },
  interactions: {
    'herbalism:plant': { intent: 'herbalism:pick', label: 'Gather' },
    'herbalism:cauldron': { intent: 'herbalism:brew', label: 'Brew at', opens: 'crafting' },
  },
  windows: {
    'herbalism:guide': {
      title: 'Herbalism',
      icon: '🌿',
      hotkey: 'KeyN',
      order: 36,
      component: Guide,
    },
  },
});
