import { useEffect, useReducer } from 'react';
import { defineClient, type ClientAPI } from '@game/shared';
import type { MyGrave } from './index.ts';
import './graves.css';

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

function clock(ms: number): string {
  const s = ms > 0 ? (ms / 1000) | 0 : 0;
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`;
}

function GraveTracker({ client }: { client: ClientAPI }) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  const me = client.localPlayer();
  const raw = me?.components['graves:mine'];
  if (!me || typeof raw !== 'object' || raw === null) return null;
  const g = raw as MyGrave;
  const now = Date.now();
  const here = (me.world ?? 'overworld') === g.world;
  const dx = g.x - me.x;
  const dy = g.y - me.y;
  const dist = abs(dx) > abs(dy) ? abs(dx) : abs(dy);
  const open = now >= g.opens;
  return (
    <div className={`frame grave-tracker${open ? ' open' : ''}`}>
      <div className="grave-head">
        🪦 Your grave <span className="grave-count">{g.count} items</span>
      </div>
      <div className="grave-where">{here ? (dist <= 1 ? 'Right here: reclaim it!' : `${dist} tiles ${ARROWS[octant(dx, dy)]}`) : 'In another world'}</div>
      <div className="grave-time">
        {open ? `Anyone can loot it · crumbles in ${clock(g.crumbles - now)}` : `Yours alone for ${clock(g.opens - now)}`}
      </div>
    </div>
  );
}

export default defineClient({
  interactions: {
    'graves:grave': { intent: 'graves:reclaim', label: 'Reclaim from' },
  },
  hud: { 'graves:tracker': GraveTracker },
});
