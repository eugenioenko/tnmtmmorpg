import { useEffect, useReducer } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';

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

const TOKEN_KEY = 'tnmt:town-token';

function token(): string {
  try {
    const existing = localStorage.getItem(TOKEN_KEY);
    if (existing && /^[a-z0-9]{16,64}$/.test(existing)) return existing;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const fresh = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(TOKEN_KEY, fresh);
    return fresh;
  } catch {
    return '';
  }
}

/**
 * Claims this browser's saved quest log on every new connection, and says
 * so once when a bring-quest's items are all in the pack.
 */
function QuestWatcher({ client }: { client: ClientAPI }) {
  useEffect(() => {
    const ready = new Set<string>();
    let claimed: number | null = null;
    return client.subscribe(() => {
      const me = client.localPlayer();
      if (me && me.id !== claimed) {
        claimed = me.id;
        const t = token();
        if (t) client.sendIntent({ t: 'intent', kind: 'town:claim', token: t });
      }
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

export default defineClient({
  interactions: {
    npc: { intent: 'town:chat', label: 'Talk to' },
  },
  hud: { 'town:tracker': Tracker, 'town:watcher': QuestWatcher },
  windows: {
    'town:journal': { title: 'Journal', icon: '📜', hotkey: 'KeyJ', order: 20, component: Journal },
  },
});
