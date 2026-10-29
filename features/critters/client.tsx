import { useEffect, useRef } from 'react';
import { defineClient, type ClientAPI } from '@game/shared';
import './critters.css';

type Kind = 'butterfly' | 'firefly' | 'leaf' | 'ripple' | 'snow';

interface Critter {
  kind: Kind;
  el: HTMLDivElement;
  /** World position in tiles. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  seed: number;
}

interface Rule {
  kind: Kind;
  max: number;
  /** Chance per frame to try a spawn. */
  rate: number;
  tiles: string[];
  when: (dark: number) => boolean;
  life: [number, number];
}

const RULES: Rule[] = [
  { kind: 'butterfly', max: 6, rate: 0.03, tiles: ['grass'], when: (d) => d < 0.3, life: [7000, 12000] },
  { kind: 'firefly', max: 26, rate: 0.12, tiles: ['grass', 'forest', 'swamp'], when: (d) => d > 0.4, life: [5000, 9000] },
  { kind: 'leaf', max: 8, rate: 0.05, tiles: ['forest'], when: () => true, life: [2600, 3600] },
  { kind: 'ripple', max: 3, rate: 0.02, tiles: ['water'], when: () => true, life: [1300, 1300] },
  { kind: 'snow', max: 40, rate: 0.5, tiles: ['snow'], when: () => true, life: [2500, 3500] },
];

const WINGS = ['#f6d36b', '#f08fb4', '#9fd0ff', '#ffffff', '#ffb066', '#c3a0ff'];
const LEAVES = ['#6f9a3f', '#8db04d', '#c98b3a', '#a8c060'];

let state = 2463534242;
function rand(): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}

/** A sine-like swing in -1..1 with period 1. */
function swing(t: number): number {
  const p = t - (t | 0) + (t < 0 ? 1 : 0);
  const tri = 4 * (p < 0.5 ? 0.5 - p : p - 0.5) - 1;
  return tri * (1.5 - 0.5 * tri * tri);
}

function outdoors(client: ClientAPI): boolean {
  const w = client.localPlayer()?.world ?? 'overworld';
  return !w.startsWith('interior:') && !w.startsWith('dungeon:');
}

function make(layer: HTMLDivElement, rule: Rule, x: number, y: number, now: number): Critter {
  const el = document.createElement('div');
  el.className = `critter ${rule.kind}`;
  const seed = rand();
  if (rule.kind === 'butterfly') {
    el.style.setProperty('--wing', WINGS[(seed * WINGS.length) | 0]);
    el.innerHTML = '<i></i><i></i>';
  } else if (rule.kind === 'leaf') {
    el.style.background = LEAVES[(seed * LEAVES.length) | 0];
  }
  layer.appendChild(el);
  const [lo, hi] = rule.life;
  return {
    kind: rule.kind,
    el,
    x,
    y,
    vx: rule.kind === 'snow' ? 0.4 + seed * 0.3 : (seed - 0.5) * 0.6,
    vy: rule.kind === 'snow' ? 1.6 + seed : rule.kind === 'leaf' ? 0.9 : (rand() - 0.5) * 0.4,
    born: now,
    life: lo + (hi - lo) * rand(),
    seed,
  };
}

/** Advance one critter; returns false once it is done. */
function step(c: Critter, now: number, dt: number): boolean {
  const age = (now - c.born) / c.life;
  if (age >= 1) return false;
  const t = (now - c.born) / 1000;
  switch (c.kind) {
    case 'butterfly':
      c.x += (c.vx + swing(t * 0.35 + c.seed) * 0.7) * dt;
      c.y += (c.vy + swing(t * 0.5 + c.seed * 3) * 0.5) * dt;
      break;
    case 'firefly':
      c.x += (c.vx * 0.4 + swing(t * 0.2 + c.seed) * 0.25) * dt;
      c.y += (c.vy * 0.4 + swing(t * 0.27 + c.seed * 5) * 0.2) * dt;
      break;
    case 'leaf':
      c.x += swing(t * 0.7 + c.seed) * 0.9 * dt;
      c.y += c.vy * dt;
      break;
    case 'snow':
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      break;
    case 'ripple':
      break;
  }
  const fade = age < 0.15 ? age / 0.15 : age > 0.8 ? (1 - age) / 0.2 : 1;
  let alpha = fade;
  if (c.kind === 'firefly') alpha *= 0.35 + 0.65 * (0.5 + 0.5 * swing(t * 0.6 + c.seed * 7));
  c.el.style.opacity = alpha.toFixed(2);
  if (c.kind === 'ripple') c.el.style.setProperty('--r', age.toFixed(3));
  if (c.kind === 'butterfly') c.el.classList.toggle('flip', swing(t * 0.35 + c.seed) < 0);
  return true;
}

/** Ambient life drawn over the world: one rAF loop, no React work per frame. */
function Critters({ client }: { client: ClientAPI }) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = layer.current;
    if (!root) return;
    const live: Critter[] = [];
    let frame = 0;
    let last = performance.now();
    let world = '';
    const clear = (): void => {
      for (const c of live) c.el.remove();
      live.length = 0;
    };
    const tick = (): void => {
      const now = performance.now();
      const dt = (now - last) / 1000 > 0.1 ? 0.1 : (now - last) / 1000;
      last = now;
      const me = client.localPlayer();
      const here = me?.world ?? '';
      if (here !== world) {
        world = here;
        clear();
      }
      if (me && outdoors(client) && !document.hidden) {
        const dark = client.darkness();
        for (const rule of RULES) {
          if (!rule.when(dark) || rand() > rule.rate) continue;
          if (live.filter((c) => c.kind === rule.kind).length >= rule.max) continue;
          const x = me.x + ((rand() * 40) | 0) - 20;
          const y = me.y + ((rand() * 26) | 0) - 13;
          if (!rule.tiles.includes(client.tileAt(x, y))) continue;
          const spot = rule.kind === 'snow' ? { x: x + rand(), y: y - 3 } : { x: x + rand(), y: y + rand() };
          live.push(make(root, rule, spot.x, spot.y, now));
        }
      }
      for (let i = live.length - 1; i >= 0; i--) {
        const c = live[i];
        if (!step(c, now, dt) || (c.kind === 'firefly' && client.darkness() < 0.25)) {
          c.el.remove();
          live.splice(i, 1);
          continue;
        }
        const p = client.tileToScreen(c.x, c.y);
        c.el.style.transform = `translate(${p.x | 0}px, ${p.y | 0}px)`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clear();
    };
  }, [client]);
  return <div className="critters" ref={layer} />;
}

export default defineClient({
  overlay: { 'critters:ambience': Critters },
});
