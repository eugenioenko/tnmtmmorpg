import { useEffect, useReducer, useRef } from 'react';
import { defineClient, type ClientAPI } from '@game/shared';
import { ITEMS, type Skill, type Skills, type Work } from './index.ts';
import './professions.css';

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

/** The swing in progress, as a cast bar over the action bar. */
function CastBar({ client }: { client: ClientAPI }) {
  useLive(client);
  const started = useRef<{ n: number; at: number } | null>(null);
  const work = client.localPlayer()?.components['professions:work'] as Work | undefined;
  if (!work) return null;
  if (started.current?.n !== work.n) started.current = { n: work.n, at: performance.now() };
  return (
    <div className="cast-bar">
      <div className="cast-label">{work.label}</div>
      <div className="cast-track">
        <div key={work.n} className="cast-fill" style={{ animationDuration: `${work.ms}ms` }} />
      </div>
    </div>
  );
}

const SKILLS: { id: Skill; name: string; icon: string; tool: string; nodes: string }[] = [
  { id: 'mining', name: 'Mining', icon: '⛏️', tool: 'Pickaxe', nodes: 'Copper (1) · Iron (10) · Mithril (20)' },
  { id: 'woodcutting', name: 'Woodcutting', icon: '🪓', tool: 'Hatchet', nodes: 'Trees (1) · Elder Oak (10) · Ironwood (20)' },
];

function SkillsWindow({ client }: { client: ClientAPI }) {
  useLive(client);
  const skills = client.localPlayer()?.components['professions:skills'] as Skills | undefined;
  if (!skills) return <div className="muted">Your trades are still being looked up…</div>;
  return (
    <div style={{ width: 300 }}>
      {SKILLS.map((s) => {
        const st = skills[s.id];
        const span = st.next - st.prev;
        const pct = span > 0 ? ((st.xp - st.prev) / span) * 100 : 100;
        return (
          <div key={s.id} className="skill-row">
            <div className="skill-icon">{s.icon}</div>
            <div className="skill-body">
              <div className="skill-head">
                <span className="skill-name">{s.name}</span>
                <span className="skill-level">Lv {st.level}</span>
              </div>
              <div className="skill-track">
                <div className="skill-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="skill-note">
                {st.xp - st.prev} / {span} XP · needs a {s.tool.toLowerCase()}
              </div>
              <div className="skill-note">{s.nodes}</div>
            </div>
          </div>
        );
      })}
      <div className="section-title">Crafting</div>
      <div className="hint">
        Smelt ore and smith gear at the <b>Forge</b>; saw logs into planks and carve charms at the{' '}
        <b>Sawbench</b>. Both stand in the village square. Tools are sold by Odo the Trader.
      </div>
    </div>
  );
}

export default defineClient({
  items: ITEMS,
  sprites: {
    'professions:forge': '🔥',
    'professions:sawbench': '🪚',
  },
  interactions: {
    'nature:tree': { intent: 'professions:gather', label: 'Chop', requires: 'professions:hatchet' },
    'professions:node': { intent: 'professions:gather', label: 'Gather' },
    'professions:forge': { intent: 'professions:station', label: 'Work at', opens: 'crafting' },
    'professions:sawbench': { intent: 'professions:station', label: 'Work at', opens: 'crafting' },
  },
  overlay: { 'professions:cast': CastBar },
  windows: {
    'professions:skills': { title: 'Professions', icon: '⛏️', hotkey: 'KeyP', order: 35, component: SkillsWindow },
  },
});
