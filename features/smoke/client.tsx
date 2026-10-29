import { useEffect, useRef } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import './smoke.css';

type Tone = 'smoke' | 'soot' | 'steam' | 'brew';

/** What rises from one kind of thing: puffs per second, where from (tiles from its corner) and how big. */
interface Source {
  tone: Tone;
  rate: number;
  dx: number;
  dy: number;
  size: number;
  life: number;
  /** Embers per second, if it throws sparks. */
  sparks?: number;
}

const COTTAGE: Source = { tone: 'smoke', rate: 2.2, dx: -0.25, dy: -3.3, size: 1, life: 4.5 };

const SOURCES: Record<string, Source> = {
  'lighting:campfire': { tone: 'smoke', rate: 3.5, dx: 0.5, dy: 0.2, size: 0.9, life: 3.5, sparks: 2.5 },
  'professions:forge': { tone: 'soot', rate: 4, dx: 0.5, dy: -0.3, size: 1.1, life: 3.8, sparks: 5 },
  'farming:oven': { tone: 'smoke', rate: 1.6, dx: 0.5, dy: -0.4, size: 0.8, life: 3.2 },
  'herbalism:cauldron': { tone: 'brew', rate: 3, dx: 0.5, dy: 0.1, size: 0.7, life: 2.2 },
  'lighting:planted': { tone: 'soot', rate: 1.2, dx: 0.5, dy: -0.3, size: 0.4, life: 2 },
  'weather:scorch': { tone: 'steam', rate: 3, dx: 0.5, dy: 0.4, size: 0.6, life: 1.8 },
};

const COLOURS: Record<Tone, string> = {
  smoke: '196,196,204',
  soot: '92,88,92',
  steam: '236,242,250',
  brew: '170,226,160',
};

interface Puff {
  tone: Tone;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  born: number;
  life: number;
  seed: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
}

let state = 1597334677;
function rand(): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}

function sourceOf(e: EntityState): Source | undefined {
  if (e.kind === 'buildings:door') {
    const frame = (e.components.appearance as { frame?: string } | undefined)?.frame;
    return frame === 'buildings/cottage' ? COTTAGE : undefined;
  }
  return SOURCES[e.kind];
}

/** A soft round puff, drawn once and stamped everywhere. */
function puffImage(rgb: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.5, `rgba(${rgb},0.55)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  return c;
}

/** Smoke from chimneys, campfires and the forge, steam off the cauldron. One canvas, one rAF loop. */
function SmokeLayer({ client }: { client: ClientAPI }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const images = Object.fromEntries(Object.entries(COLOURS).map(([tone, rgb]) => [tone, puffImage(rgb)])) as Record<Tone, HTMLCanvasElement>;
    const puffs: Puff[] = [];
    const sparks: Spark[] = [];
    const owed = new Map<number, number>();
    let frame = 0;
    let last = performance.now();

    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = (now - last) / 1000 > 0.1 ? 0.1 : (now - last) / 1000;
      last = now;
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
      const screen = (x: number, y: number): [number, number] => [origin.x + (x - me.x) * ts, origin.y + (y - me.y) * ts];
      const wx = me.components['weather:here'] as { wind?: number; sky?: string } | undefined;
      const wind = 0.15 + (wx?.wind ?? 0.3) * 1.1;
      const wet = wx?.sky === 'rain' || wx?.sky === 'storm';
      const dark = client.darkness();

      for (const e of client.entities()) {
        if (e.world !== me.world) continue;
        const src = sourceOf(e);
        if (!src) continue;
        const [sx, sy] = screen(e.x, e.y);
        if (sx < -6 * ts || sx > W + 6 * ts || sy < -2 * ts || sy > H + 6 * ts) continue;
        let due = (owed.get(e.id) ?? rand()) + src.rate * dt;
        while (due >= 1 && puffs.length < 600) {
          due -= 1;
          puffs.push({
            tone: src.tone,
            x: e.x + src.dx + (rand() - 0.5) * 0.2,
            y: e.y + src.dy,
            vx: (rand() - 0.5) * 0.15,
            vy: -(0.55 + rand() * 0.35),
            size: src.size * (0.8 + rand() * 0.4),
            born: now,
            life: src.life * (wet ? 0.6 : 1) * (0.8 + rand() * 0.4) * 1000,
            seed: rand(),
          });
        }
        if (src.sparks && rand() < src.sparks * dt && sparks.length < 120) {
          sparks.push({ x: e.x + 0.5 + (rand() - 0.5) * 0.3, y: e.y + src.dy, vx: (rand() - 0.5) * 0.6, vy: -(1 + rand() * 1.2), born: now, life: 600 + rand() * 700 });
        }
        owed.set(e.id, due);
      }
      if (owed.size > 400) owed.clear();

      const shade = 1 - dark * 0.75;
      for (let i = puffs.length - 1; i >= 0; i--) {
        const p = puffs[i];
        const age = (now - p.born) / p.life;
        if (age >= 1) {
          puffs.splice(i, 1);
          continue;
        }
        p.vy *= 1 - 0.35 * dt;
        p.x += (p.vx + wind * age) * dt;
        p.y += p.vy * dt;
        const r = (0.22 + age * 0.9) * p.size * ts;
        const [x, y] = screen(p.x, p.y);
        const fade = age < 0.06 ? age / 0.06 : 1 - (age - 0.06) / 0.94;
        g.globalAlpha = fade * (p.tone === 'soot' ? 0.62 : 0.55) * shade;
        g.drawImage(images[p.tone], x - r, y - r, r * 2, r * 2);
      }
      g.globalAlpha = 1;

      g.globalCompositeOperation = 'lighter';
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        const age = (now - s.born) / s.life;
        if (age >= 1) {
          sparks.splice(i, 1);
          continue;
        }
        s.vy += 0.6 * dt;
        s.x += (s.vx + wind * 0.5) * dt;
        s.y += s.vy * dt;
        const [x, y] = screen(s.x, s.y);
        g.fillStyle = `rgba(255,${(150 + (1 - age) * 90) | 0},60,${(1 - age).toFixed(2)})`;
        g.fillRect(x, y, 2, 2);
      }
      g.globalCompositeOperation = 'source-over';
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [client]);
  return <canvas className="smoke-layer" ref={canvas} />;
}

export default defineClient({
  overlay: { 'smoke:plumes': SmokeLayer },
});
