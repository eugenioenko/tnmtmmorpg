import { useEffect, useReducer } from 'react';
import { defineClient, type ClientAPI } from '@game/shared';
import { ITEMS, type OmenAlert } from './index.ts';
import './omens.css';

function alertOf(client: ClientAPI): OmenAlert | undefined {
  const raw = client.localPlayer()?.components['omens:alert'];
  return typeof raw === 'object' && raw !== null ? (raw as OmenAlert) : undefined;
}

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
const abs = (n: number): number => (n < 0 ? -n : n);

function octant(dx: number, dy: number): number {
  const ax = abs(dx);
  const ay = abs(dy);
  if (ay * 5 < ax * 2) return dx > 0 ? 0 : 4;
  if (ax * 5 < ay * 2) return dy > 0 ? 2 : 6;
  if (dx > 0) return dy > 0 ? 1 : 7;
  return dy > 0 ? 3 : 5;
}

/** Banners as an omen rises and falls, once each. */
function useBanners(client: ClientAPI): void {
  useEffect(() => {
    let seen = '';
    let primed = false;
    return client.subscribe(() => {
      const a = alertOf(client);
      const key = a ? `${a.n}:${a.state}` : '';
      if (!primed) {
        primed = client.localPlayer() !== undefined;
        seen = key;
        return;
      }
      if (!a || key === seen) return;
      seen = key;
      if (a.state === 'risen') {
        client.banner(`${a.name} rises!`, `${a.title} · level ${a.level}. Everyone who strikes it shares the spoils.`, 'death');
        client.notify(`An omen: ${a.name}, ${a.title}, has risen. Follow the tracker.`, 'quest');
      } else if (a.state === 'slain') {
        client.banner(`${a.name} has fallen`, a.slayers?.length ? `Slain by ${a.slayers.join(', ')}` : undefined, 'level');
      } else {
        client.notify(`${a.name} slinks back into the wilds, unchallenged.`, 'info');
      }
    });
  }, [client]);
}

function Tracker({ client }: { client: ClientAPI }) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  useBanners(client);
  const a = alertOf(client);
  const me = client.localPlayer();
  if (!a || !me || a.state !== 'risen') return null;
  const here = (me.world ?? 'overworld') === a.world;
  const dx = a.x - me.x;
  const dy = a.y - me.y;
  const dist = abs(dx) > abs(dy) ? abs(dx) : abs(dy);
  const pct = a.maxHp > 0 ? (a.hp / a.maxHp) * 100 : 0;
  return (
    <div className="frame omen-tracker">
      <div className="omen-name">
        ☠ {a.name}
        <span className="omen-level">Lv {a.level}</span>
      </div>
      <div className="omen-title">{a.title}</div>
      <div className="bar enemy omen-hp">
        <div className="fill" style={{ width: `${pct < 0 ? 0 : pct > 100 ? 100 : pct}%` }} />
      </div>
      <div className="omen-where">
        {here ? (dist <= 2 ? 'Right here!' : `${dist} tiles ${ARROWS[octant(dx, dy)]}`) : 'In the overworld'}
      </div>
    </div>
  );
}

export default defineClient({
  items: ITEMS,
  hud: { 'omens:tracker': Tracker },
});
