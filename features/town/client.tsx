import { useEffect, useReducer, useRef } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import './town.css';

interface QuestEntry {
  id: string;
  title: string;
  progress: number;
  goal: number;
  objective: string;
  turnIn: string;
}

interface QuestLog {
  active: QuestEntry[];
  done: string[];
}

function usePlayer(client: ClientAPI): EntityState | undefined {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  return client.localPlayer();
}

function quests(e: EntityState | undefined): QuestLog {
  const q = e?.components.quests as Partial<QuestLog> | undefined;
  return { active: Array.isArray(q?.active) ? q.active : [], done: Array.isArray(q?.done) ? q.done : [] };
}

/** Bring-quests count what is in the pack right now, not a stored number. */
function progress(e: EntityState | undefined, entry: QuestEntry): number {
  const item = BRING[entry.id];
  if (!item) return entry.progress;
  const inv = e?.components.inventory as { slots?: { itemId: string; count: number }[] } | undefined;
  const have = (inv?.slots ?? []).reduce((n, s) => (s.itemId === item ? n + s.count : n), 0);
  return have > entry.goal ? entry.goal : have;
}

const BRING: Record<string, string> = {
  feathers: 'bestiary:feather',
  pelts: 'bestiary:wolf_pelt',
  embers: 'bestiary:ember_fang',
};

function Tracker({ client }: { client: ClientAPI }) {
  const me = usePlayer(client);
  const log = quests(me);
  if (log.active.length === 0) return null;
  return (
    <div className="tracker interactive" onClick={() => client.toggleWindow('town:journal', true)}>
      <div className="t-head">Quests</div>
      {log.active.slice(0, 4).map((q) => {
        const p = progress(me, q);
        const done = p >= q.goal;
        return (
          <div key={q.id} className="t-quest">
            <div className={`t-title${done ? ' done' : ''}`}>{q.title}</div>
            <div className="t-obj">
              {done ? `Return to ${q.turnIn}` : `${q.objective}${q.goal > 1 ? `: ${p}/${q.goal}` : ''}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Journal({ client }: { client: ClientAPI }) {
  const me = usePlayer(client);
  const log = quests(me);
  return (
    <div style={{ width: 320 }}>
      <div className="section-title">Active</div>
      {log.active.length === 0 && (
        <div className="muted">No quests. Speak with the villagers — look for golden dots on the map.</div>
      )}
      {log.active.map((q) => {
        const p = progress(me, q);
        const done = p >= q.goal;
        return (
          <div key={q.id} className={`quest${done ? ' done' : ''}`}>
            <div className="q-title">{q.title}</div>
            <div className="q-progress">
              {q.objective}
              {q.goal > 1 ? ` — ${p}/${q.goal}` : done ? ' — done' : ''}
            </div>
            <div className="q-desc">{done ? `Return to ${q.turnIn}.` : `Report to ${q.turnIn} when finished.`}</div>
          </div>
        );
      })}
      <div className="section-title">Completed · {log.done.length}</div>
      <div className="hint">{log.done.length === 0 ? 'None yet.' : 'Your deeds are remembered in the village.'}</div>
    </div>
  );
}

/** Says so once when a bring-quest's items are all in the pack. */
function QuestWatcher({ client }: { client: ClientAPI }) {
  useEffect(() => {
    const ready = new Set<string>();
    return client.subscribe(() => {
      const me = client.localPlayer();
      for (const q of quests(me).active) {
        if (!BRING[q.id]) continue;
        const done = progress(me, q) >= q.goal;
        if (done && !ready.has(q.id)) {
          ready.add(q.id);
          client.notify(`${q.title}: you have everything. Return to ${q.turnIn}.`, 'quest');
        } else if (!done) ready.delete(q.id);
      }
    });
  }, [client]);
  return null;
}

/** A drowsy zZ over residents who have gone to bed. */
function Snores({ client }: { client: ClientAPI }) {
  usePlayer(client);
  const nodes = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    let frame = 0;
    const place = (): void => {
      for (const [id, el] of nodes.current) {
        const p = client.screenOf(id);
        el.style.visibility = p ? 'visible' : 'hidden';
        if (p) el.style.transform = `translate(${(p.x | 0) + 8}px, ${(p.y | 0) - 50}px)`;
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [client]);
  const sleepers: number[] = [];
  for (const e of client.entities()) if (e.components['town:asleep'] === true) sleepers.push(e.id);
  return (
    <div className="town-snores">
      {sleepers.map((id) => (
        <div
          key={id}
          className="town-snore"
          ref={(el) => {
            if (el) nodes.current.set(id, el);
            else nodes.current.delete(id);
          }}
        >
          z<span>Z</span>
        </div>
      ))}
    </div>
  );
}

export default defineClient({
  overlay: { 'town:snores': Snores },
  interactions: {
    npc: { intent: 'town:chat', label: 'Talk to' },
  },
  hud: { 'town:tracker': Tracker, 'town:watcher': QuestWatcher },
  windows: {
    'town:journal': { title: 'Journal', icon: '📜', hotkey: 'KeyJ', order: 20, component: Journal },
  },
});
