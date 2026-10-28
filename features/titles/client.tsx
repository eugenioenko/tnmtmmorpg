import { useEffect, useReducer, useRef } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import { TITLES, type Progress, type Worn } from './index.ts';
import './titles.css';

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

function wornOf(e: EntityState | undefined): Worn | undefined {
  const w = e?.components['titles:worn'] as Worn | undefined;
  return typeof w?.text === 'string' ? w : undefined;
}

function progressOf(e: EntityState | undefined): Progress {
  const p = e?.components['titles:progress'] as Progress | undefined;
  return p && typeof p.counts === 'object' && Array.isArray(p.earned) ? p : { counts: {}, earned: [] };
}

function TitlesWindow({ client }: { client: ClientAPI }) {
  useLive(client);
  const me = client.localPlayer();
  const prog = progressOf(me);
  const worn = wornOf(me)?.id;
  const earned = TITLES.filter((t) => prog.earned.includes(t.id));
  const locked = TITLES.filter((t) => !prog.earned.includes(t.id));
  const wear = (id: string | null): void => client.sendIntent({ t: 'intent', kind: 'titles:wear', id });
  return (
    <div className="titles">
      <div className="section-title">
        Earned ({earned.length}/{TITLES.length})
      </div>
      {earned.length === 0 && <div className="muted">No titles yet. Deeds below earn them.</div>}
      <div className="title-earned">
        {earned.map((t) => (
          <button key={t.id} type="button" className={`title-chip${t.id === worn ? ' on' : ''}`} title={t.how} onClick={() => wear(t.id === worn ? null : t.id)}>
            {t.text}
          </button>
        ))}
      </div>
      {earned.length > 0 && <div className="muted title-hint">{worn ? 'Click your title again to take it off.' : 'Click a title to wear it over your head.'}</div>}
      <div className="section-title">Still to earn</div>
      {locked.map((t) => {
        const have = prog.counts[t.stat] ?? 0;
        const pct = (have / t.need) * 100;
        return (
          <div key={t.id} className="title-row">
            <div className="title-row-head">
              <span className="title-text">{t.text}</span>
              <span className="muted">
                {have > t.need ? t.need : have}/{t.need}
              </span>
            </div>
            <div className="title-how muted">{t.how}</div>
            <div className="title-track">
              <div className="title-fill" style={{ width: `${pct > 100 ? 100 : pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The worn title over each character's head, above the guild tag if there is one. */
function Overhead({ client }: { client: ClientAPI }) {
  useLive(client);
  const nodes = useRef(new Map<number, { el: HTMLDivElement; lift: number }>());
  useEffect(() => {
    let frame = 0;
    const place = (): void => {
      for (const [id, n] of nodes.current) {
        const p = client.screenOf(id);
        n.el.style.visibility = p ? 'visible' : 'hidden';
        if (p) n.el.style.transform = `translate(${p.x | 0}px, ${(p.y | 0) + 2 - n.lift}px) translate(-50%, -100%)`;
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [client]);
  const shown: { id: number; text: string; lift: number }[] = [];
  for (const e of client.entities()) {
    const w = e.kind === 'player' ? wornOf(e) : undefined;
    if (w) shown.push({ id: e.id, text: w.text, lift: e.components['guilds:tag'] ? 11 : 0 });
  }
  return (
    <div className="title-overhead">
      {shown.map((s) => (
        <div
          key={s.id}
          className="title-over"
          ref={(el) => {
            if (el) nodes.current.set(s.id, { el, lift: s.lift });
            else nodes.current.delete(s.id);
          }}
        >
          {s.text}
        </div>
      ))}
    </div>
  );
}

export default defineClient({
  windows: {
    'titles:titles': { title: 'Titles', icon: '🏅', hotkey: 'KeyH', component: TitlesWindow, order: 35 },
  },
  overlay: { 'titles:overhead': Overhead },
});
