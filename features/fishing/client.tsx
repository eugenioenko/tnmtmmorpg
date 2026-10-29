import { useEffect, useReducer, useRef } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import { CATCHES, ITEMS, type Caught, type FishSkill, type Line } from './index.ts';
import './fishing.css';

const PI = 3.14159265;

function sin(a: number): number {
  const p = a / (2 * PI) - ((a / (2 * PI)) | 0) + (a < 0 ? 1 : 0);
  const tri = 4 * (p < 0.5 ? (p < 0.25 ? p : 0.5 - p) : p < 0.75 ? 0.5 - p : p - 1);
  return tri * (1.5 - 0.5 * tri * tri);
}

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

/** Which number key uses the rod: the hotbar lists usable consumables in pack order. */
function rodKey(client: ClientAPI, me: EntityState): number | undefined {
  const inv = me.components.inventory as { slots?: { itemId: string; count: number }[] } | undefined;
  const seen: string[] = [];
  for (const s of inv?.slots ?? []) {
    if (s.count <= 0 || seen.includes(s.itemId)) continue;
    const def = client.itemDef(s.itemId);
    if (!def?.use || !def.tags.includes('consumable')) continue;
    if (s.itemId === 'fishing:rod') return seen.length < 6 ? seen.length + 1 : undefined;
    seen.push(s.itemId);
  }
  return undefined;
}

/** Every angler's line and bobber, the bite, and the catch flying home. */
function Lines({ client }: { client: ClientAPI }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    let frame = 0;
    const flights = new Map<number, { at: number; seen: number; icon: string; x: number; y: number }>();
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      const W = cv.parentElement?.clientWidth ?? 0;
      const H = cv.parentElement?.clientHeight ?? 0;
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      g.clearRect(0, 0, W, H);
      const me = client.localPlayer();
      if (!me || document.hidden) return;
      const origin = client.tileToScreen(me.x, me.y);
      const ts = client.tileToScreen(me.x + 1, me.y).x - origin.x || 32;
      const t = performance.now() / 1000;
      const now = performance.now();
      const dim = 1 - client.darkness() * 0.5;
      for (const e of client.entities()) {
        if (e.world !== me.world) continue;
        const line = e.components['fishing:line'] as Line | undefined;
        const caught = e.components['fishing:caught'] as Caught | undefined;
        const at = client.screenOf(e.id) ?? client.tileToScreen(e.x + 0.5, e.y + 0.5);
        const tipX = at.x + ts * 0.45;
        const tipY = at.y - ts * 0.75;
        if (line) {
          const b = client.tileToScreen(line.x + 0.5, line.y + 0.55);
          const bob = line.biting ? 3 + sin(t * 30) * 2 : sin(t * 2.4 + e.id) * 1.5;
          const bx = b.x;
          const by = b.y + bob;
          g.strokeStyle = `rgba(235,235,225,${(0.7 * dim).toFixed(2)})`;
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(tipX, tipY);
          g.quadraticCurveTo((tipX + bx) / 2, (tipY > by ? tipY : by) + ts * 0.4, bx, by);
          g.stroke();
          const ring = (t * (line.biting ? 2.5 : 0.7) + e.id * 0.37) % 1;
          g.strokeStyle = `rgba(220,236,255,${((1 - ring) * 0.6 * dim).toFixed(2)})`;
          g.beginPath();
          g.ellipse(bx, b.y + 3, 3 + ring * ts * 0.4, 1.5 + ring * ts * 0.15, 0, 0, PI * 2);
          g.stroke();
          g.fillStyle = '#f4f1e8';
          g.beginPath();
          g.arc(bx, by, 3, 0, PI * 2);
          g.fill();
          g.fillStyle = '#d8402f';
          g.beginPath();
          g.arc(bx, by - 1, 3, PI, PI * 2);
          g.fill();
          if (line.biting) {
            g.font = `bold ${(ts * 0.6) | 0}px sans-serif`;
            g.textAlign = 'center';
            g.fillStyle = '#ffd34d';
            g.strokeStyle = 'rgba(0,0,0,0.7)';
            g.lineWidth = 3;
            g.strokeText('!', bx, by - ts * 0.35);
            g.fillText('!', bx, by - ts * 0.35);
            if (e.id === me.id) {
              const key = rodKey(client, me);
              const text = key ? `Reel in! [${key}]` : 'Reel in! (use your rod)';
              g.font = `bold ${(ts * 0.42) | 0}px sans-serif`;
              g.strokeText(text, at.x, at.y - ts * 1.6);
              g.fillText(text, at.x, at.y - ts * 1.6);
            }
          }
        }
        const flight = flights.get(e.id);
        if (!flight) flights.set(e.id, { at: caught?.at ?? 0, seen: -1e9, icon: '', x: 0, y: 0 });
        else if (caught && flight.at !== caught.at) flights.set(e.id, { at: caught.at, seen: now, icon: caught.icon, x: caught.x, y: caught.y });
        const fly = flights.get(e.id);
        if (fly && now - fly.seen < 900) {
          const k = (now - fly.seen) / 900;
          const from = client.tileToScreen(fly.x + 0.5, fly.y + 0.5);
          const x = from.x + (at.x - from.x) * k;
          const y = from.y + (at.y - ts * 0.5 - from.y) * k - sin(k * PI) * ts * 2.2;
          g.font = `${(ts * 0.8) | 0}px sans-serif`;
          g.textAlign = 'center';
          g.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : 1;
          g.fillText(fly.icon, x, y);
          g.globalAlpha = 1;
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [client]);
  return <canvas className="fishing-lines" ref={canvas} />;
}

/** The angler's journal: your skill, and every catch you have (and have not yet) landed. */
function Journal({ client }: { client: ClientAPI }) {
  useLive(client);
  const me = client.localPlayer();
  const skill = (me?.components['fishing:skill'] as FishSkill | undefined) ?? { level: 1, xp: 0, prev: 0, next: 30 };
  const log = (me?.components['fishing:journal'] as Record<string, number> | undefined) ?? {};
  const span = skill.next - skill.prev;
  const pct = span > 0 ? ((skill.xp - skill.prev) / span) * 100 : 100;
  const found = CATCHES.filter((c) => log[c.id]).length;
  return (
    <div className="fish-journal">
      <div className="fish-skill">
        <span>🎣 Fishing</span>
        <span className="fish-level">Lv {skill.level}</span>
      </div>
      <div className="fish-track">
        <div className="fish-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="fish-note">
        {skill.xp - skill.prev} / {span} XP · {found} of {CATCHES.length} catches recorded
      </div>
      <div className="fish-list">
        {CATCHES.map((c) => {
          const n = log[c.id] ?? 0;
          const locked = skill.level < c.level;
          return (
            <div key={c.id} className={`fish-row${n ? '' : ' unknown'}${locked ? ' locked' : ''}`}>
              <span className="fish-icon">{n ? c.icon : '❔'}</span>
              <span className="fish-body">
                <b>{n ? c.name : '???'}</b>
                <span className="fish-where">{c.where}</span>
              </span>
              <span className="fish-count">{locked ? `Lv ${c.level}` : n ? `×${n}` : ''}</span>
            </div>
          );
        })}
      </div>
      <div className="fish-note">
        Buy a rod from Odo or cut one at the <b>Sawbench</b>. Grill your catch at the farm’s <b>Oven</b>.
      </div>
    </div>
  );
}

export default defineClient({
  items: ITEMS,
  overlay: { 'fishing:lines': Lines },
  windows: {
    'fishing:journal': {
      title: 'Fishing',
      icon: '🎣',
      hotkey: 'KeyY',
      order: 37,
      component: Journal,
    },
  },
});
