import { useEffect, useReducer, useRef } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import type { Sky, Weather } from './sky.ts';
import './weather.css';

type Kind = 'rain' | 'snow' | 'ash' | 'ember' | 'dust';

/** One falling thing. Ground position (x, y) and height z are in tiles. */
interface Mote {
  k: Kind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  seed: number;
}

interface Splash {
  x: number;
  y: number;
  t: number;
  water: boolean;
}

/** A soft patch of fog or cloud shadow, anchored to the ground so it scrolls with the world. */
interface Patch {
  x: number;
  y: number;
  r: number;
  seed: number;
}

interface Bolt {
  points: [number, number][];
  t: number;
}

const KINDS: Kind[] = ['rain', 'snow', 'ash', 'ember', 'dust'];
const RAIN_HEIGHT = 10;

let state = 88172645;
function rand(): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}

const ease = (from: number, to: number, k: number): number => from + (to - from) * k;

function weatherOf(e: EntityState | undefined): Weather | undefined {
  const w = e?.components['weather:here'];
  return typeof w === 'object' && w !== null ? (w as Weather) : undefined;
}

function outdoors(client: ClientAPI): boolean {
  const w = client.localPlayer()?.world ?? 'overworld';
  return !w.startsWith('interior:') && !w.startsWith('dungeon:');
}

function targets(w: Weather | undefined): Record<Kind, number> {
  const t: Record<Kind, number> = { rain: 0, snow: 0, ash: 0, ember: 0, dust: 0 };
  if (!w) return t;
  const a = w.amount;
  if (w.sky === 'rain') t.rain = 70 + a * 480;
  if (w.sky === 'storm') t.rain = 420 + a * 320;
  if (w.sky === 'snow') t.snow = 280 + a * 520;
  if (w.sky === 'blizzard') t.snow = 900 + a * 500;
  if (w.sky === 'ash') {
    t.ash = 180 + a * 280;
    t.ember = 10 + a * 30;
  }
  if (w.sky === 'dust') t.dust = 140 + a * 260;
  return t;
}

/** How dark the sky makes the day, and the colour of that gloom. Kept at or below 0.4, which other features read as night. */
function gloom(w: Weather | undefined): [number, number] {
  if (!w) return [0, 0];
  switch (w.sky) {
    case 'cloudy':
      return [w.amount * 0.14, 0x1c2433];
    case 'rain':
      return [0.16 + w.amount * 0.14, 0x18202e];
    case 'storm':
      return [0.32 + w.amount * 0.08, 0x10141f];
    case 'snow':
      return [0.08 + w.amount * 0.1, 0x2a3040];
    case 'blizzard':
      return [0.28, 0x2a3040];
    case 'fog':
      return [0.12, 0x2a2e36];
    case 'dust':
      return [0.25, 0x3a2410];
    case 'ash':
      return [0.3, 0x2a0e08];
    default:
      return [0, 0];
  }
}

/** A wash over everything: [r, g, b, alpha]. */
function haze(w: Weather | undefined): [number, number, number, number] {
  if (!w) return [0, 0, 0, 0];
  if (w.sky === 'fog') return [205, 212, 222, 0.12 + w.amount * 0.18];
  if (w.sky === 'dust') return [196, 150, 88, 0.15 + w.amount * 0.2];
  if (w.sky === 'blizzard') return [228, 234, 244, 0.12 + w.amount * 0.18];
  if (w.sky === 'ash') return [70, 44, 36, 0.12];
  return [0, 0, 0, 0];
}

function launch(m: Mote, w: Weather | undefined, fresh: boolean): void {
  const wind = w?.wind ?? 0.3;
  const blizzard = w?.sky === 'blizzard';
  m.seed = rand();
  switch (m.k) {
    case 'rain':
      m.vz = 17 + rand() * 6;
      m.vx = wind * (w?.sky === 'storm' ? 8 : 4);
      m.z = fresh ? rand() * RAIN_HEIGHT : RAIN_HEIGHT - 1 + rand() * 2;
      break;
    case 'snow':
      m.vz = blizzard ? 2.6 + rand() * 1.8 : 0.9 + rand() * 0.9;
      m.vx = blizzard ? 6 + rand() * 4 : wind * 1.6;
      m.z = fresh ? rand() * 8 : 7 + rand() * 2;
      break;
    case 'ash':
      m.vz = 0.5 + rand() * 0.6;
      m.vx = wind * 1.2;
      m.z = fresh ? rand() * 8 : 7 + rand() * 2;
      break;
    case 'ember':
      m.vz = -0.3 + rand() * 0.7;
      m.vx = wind * 1.6 + rand() * 0.5;
      m.z = rand() * 5;
      break;
    case 'dust':
      m.vz = rand() * 0.3;
      m.vx = 10 + rand() * 7;
      m.z = rand() * 4;
      break;
  }
}

/** The flash's brightness `ms` after the bolt: a double flicker, then a fade. */
function flashAt(ms: number): number {
  if (ms < 0) return 0;
  if (ms < 70) return 0.75;
  if (ms < 150) return 0.12;
  if (ms < 240) return 0.5;
  if (ms < 700) return 0.5 * (1 - (ms - 240) / 460);
  return 0;
}

function boltTo(sx: number, sy: number): [number, number][] {
  const points: [number, number][] = [];
  const steps = 9;
  let x = sx + (rand() - 0.5) * 120;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = -20 + (sy + 20) * t;
    x = i === steps ? sx : ease(x, sx, t * 0.5) + (rand() - 0.5) * 36;
    points.push([x, y]);
  }
  return points;
}

/** Rain, snow, ash, dust, fog and lightning over the world: one canvas, one rAF loop. */
function SkyLayer({ client }: { client: ClientAPI }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const motes: Mote[] = [];
    const splashes: Splash[] = [];
    const fog: Patch[] = [];
    const shade: Patch[] = [];
    const bolts: Bolt[] = [];
    const seen = new Set<number>();
    let flashT = -1e9;
    let lastFlash: number | undefined;
    let fogLevel = 0;
    let shadeLevel = 0;
    const tint: [number, number, number, number] = [0, 0, 0, 0];
    let dark = 0;
    let sent = 0;
    let darkTint = 0;
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
      const me = client.localPlayer();
      const out = !!me && outdoors(client) && !document.hidden;
      const w = out ? weatherOf(me) : undefined;

      const [gl, gt] = gloom(w);
      if (gt) darkTint = gt;
      dark = gl === 0 && dark < 0.005 ? 0 : ease(dark, gl, 0.6 * dt);
      if (dark - sent > 0.004 || sent - dark > 0.004 || (dark === 0 && sent !== 0)) {
        sent = dark;
        client.setDarkness('weather', dark, darkTint);
      }

      g.clearRect(0, 0, W, H);
      if (!me) return;
      const origin = client.tileToScreen(me.x, me.y);
      const ts = client.tileToScreen(me.x + 1, me.y).x - origin.x || 32;
      const left = me.x - origin.x / ts - 2;
      const right = me.x + (W - origin.x) / ts + 2;
      const top = me.y - origin.y / ts - 1;
      const bottom = me.y + (H - origin.y) / ts + 1;
      const screen = (x: number, y: number): [number, number] => [origin.x + (x - me.x) * ts, origin.y + (y - me.y) * ts];
      const night = client.darkness();
      const dim = 1 - night * 0.55;
      const wind = w?.wind ?? 0.3;

      const want = targets(w);
      const have: Record<Kind, number> = { rain: 0, snow: 0, ash: 0, ember: 0, dust: 0 };
      for (const m of motes) have[m.k]++;
      for (const k of KINDS) {
        for (let n = 0; n < 40 && have[k] < want[k]; n++, have[k]++) {
          const m: Mote = { k, x: left + rand() * (right - left), y: top + rand() * (bottom - top + RAIN_HEIGHT), z: 0, vx: 0, vz: 0, seed: 0 };
          launch(m, w, true);
          motes.push(m);
        }
      }

      const [hr, hg, hb, ha] = haze(w);
      tint[3] = ease(tint[3], ha, 0.9 * dt);
      if (ha > 0) {
        tint[0] = hr;
        tint[1] = hg;
        tint[2] = hb;
      }
      if (tint[3] > 0.005) {
        g.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${(tint[3] * dim).toFixed(3)})`;
        g.fillRect(0, 0, W, H);
      }

      const shadeWanted = w && (w.sky === 'cloudy' || w.sky === 'rain' || w.sky === 'storm') ? 0.1 + w.amount * 0.12 : 0;
      shadeLevel = ease(shadeLevel, shadeWanted, 0.6 * dt);
      const fogWanted = w?.sky === 'fog' ? 0.3 + w.amount * 0.35 : w?.sky === 'blizzard' ? 0.25 : 0;
      fogLevel = ease(fogLevel, fogWanted, 0.6 * dt);
      const patches = (list: Patch[], count: number, rMin: number, rMax: number, speed: number): void => {
        while (list.length < count) list.push({ x: left + rand() * (right - left), y: top + rand() * (bottom - top), r: rMin + rand() * (rMax - rMin), seed: rand() });
        for (const p of list) {
          p.x += speed * (0.7 + p.seed * 0.6) * dt;
          if (p.x - p.r > right) p.x = left - p.r;
          else if (p.x + p.r < left) p.x = right + p.r;
          if (p.y - p.r > bottom) p.y = top - p.r;
          else if (p.y + p.r < top) p.y = bottom + p.r;
        }
      };
      if (shadeLevel > 0.005) {
        patches(shade, 7, 7, 13, wind * 1.6 + 0.3);
        const a = shadeLevel * (1 - night);
        for (const p of shade) {
          const [x, y] = screen(p.x, p.y);
          const grad = g.createRadialGradient(x, y, 0, x, y, p.r * ts);
          grad.addColorStop(0, `rgba(8,12,24,${a.toFixed(3)})`);
          grad.addColorStop(1, 'rgba(8,12,24,0)');
          g.fillStyle = grad;
          g.fillRect(x - p.r * ts, y - p.r * ts, p.r * ts * 2, p.r * ts * 2);
        }
      }
      if (fogLevel > 0.005) {
        patches(fog, 26, 4, 9, wind * 0.6 + 0.15);
        for (const p of fog) {
          const [x, y] = screen(p.x, p.y);
          const a = fogLevel * (0.55 + 0.45 * p.seed) * dim;
          const grad = g.createRadialGradient(x, y, 0, x, y, p.r * ts);
          grad.addColorStop(0, `rgba(222,228,236,${a.toFixed(3)})`);
          grad.addColorStop(1, 'rgba(222,228,236,0)');
          g.fillStyle = grad;
          g.fillRect(x - p.r * ts, y - p.r * ts, p.r * ts * 2, p.r * ts * 2);
        }
      }

      const rainStyle = `rgba(200,216,246,${(0.66 * dim).toFixed(3)})`;
      g.lineWidth = 1;
      g.strokeStyle = rainStyle;
      g.beginPath();
      const streak = 0.045 * ts;
      for (let i = motes.length - 1; i >= 0; i--) {
        const m = motes[i];
        m.x += m.vx * dt;
        m.z -= m.vz * dt;
        if (m.k === 'snow' || m.k === 'ash') m.x += (m.seed - 0.5) * 0.8 * dt;
        const landed = m.z <= 0 || (m.k === 'ember' && m.z > 6);
        const strayed = m.x < left - 3 || m.x > right + 3 || m.y < top - 1 || m.y > bottom + RAIN_HEIGHT + 1;
        if (landed || strayed) {
          if (landed && m.k === 'rain' && m.y < bottom && splashes.length < 160) {
            splashes.push({ x: m.x, y: m.y, t: now, water: client.tileAt(m.x | 0, m.y | 0) === 'water' });
          }
          if (have[m.k] > want[m.k]) {
            have[m.k]--;
            motes.splice(i, 1);
            continue;
          }
          if (strayed) {
            m.x = left + rand() * (right - left);
            m.y = top + rand() * (bottom - top + RAIN_HEIGHT);
          } else if (m.x > right) {
            m.x -= right - left;
          }
          launch(m, w, strayed);
          if (m.k === 'dust' && !strayed) m.x = left - rand() * 2;
          continue;
        }
        if (m.k !== 'rain') continue;
        const [x, y] = screen(m.x, m.y - m.z);
        g.moveTo(x, y);
        g.lineTo(x - m.vx * streak, y - m.vz * streak);
      }
      g.stroke();

      for (const [kind, colour, edge] of [['snow', '250,252,255', '90,110,140'], ['ash', '150,140,134', '40,30,28']] as const) {
        g.fillStyle = `rgba(${edge},${(0.35 * dim).toFixed(3)})`;
        for (const m of motes) {
          if (m.k !== kind) continue;
          const [x, y] = screen(m.x, m.y - m.z);
          const s = 2 + ((m.seed * 3) | 0);
          g.fillRect(x - 1, y - 1, s + 2, s + 2);
        }
        g.fillStyle = `rgba(${colour},${(0.95 * dim).toFixed(3)})`;
        for (const m of motes) {
          if (m.k !== kind) continue;
          const [x, y] = screen(m.x, m.y - m.z);
          const s = 2 + ((m.seed * 3) | 0);
          g.fillRect(x, y, s, s);
        }
      }
      g.lineWidth = 1.5;
      g.strokeStyle = `rgba(236,206,150,${(0.6 * dim).toFixed(3)})`;
      g.beginPath();
      for (const m of motes) {
        if (m.k !== 'dust') continue;
        const [x, y] = screen(m.x, m.y - m.z);
        g.moveTo(x, y);
        g.lineTo(x - m.vx * 0.05 * ts, y);
      }
      g.stroke();
      g.globalCompositeOperation = 'lighter';
      for (const m of motes) {
        if (m.k !== 'ember') continue;
        const [x, y] = screen(m.x, m.y - m.z);
        const flick = 0.5 + 0.5 * ((((now / 90) | 0) + ((m.seed * 97) | 0)) % 3) / 2;
        g.fillStyle = `rgba(255,${(120 + m.seed * 80) | 0},40,${flick.toFixed(2)})`;
        g.fillRect(x, y, 3, 3);
      }
      g.globalCompositeOperation = 'source-over';
      g.lineWidth = 1;

      g.strokeStyle = `rgba(190,208,240,${(0.55 * dim).toFixed(3)})`;
      for (let i = splashes.length - 1; i >= 0; i--) {
        const s = splashes[i];
        const age = (now - s.t) / (s.water ? 420 : 220);
        if (age >= 1) {
          splashes.splice(i, 1);
          continue;
        }
        const [x, y] = screen(s.x, s.y);
        g.globalAlpha = 1 - age;
        g.beginPath();
        if (s.water) {
          g.ellipse(x, y, 1 + age * 6, 0.5 + age * 2.4, 0, 0, 6.2832);
        } else {
          const h = 2 + age * 3;
          g.moveTo(x - 1, y);
          g.lineTo(x - 2 - age * 2, y - h);
          g.moveTo(x + 1, y);
          g.lineTo(x + 2 + age * 2, y - h);
        }
        g.stroke();
      }
      g.globalAlpha = 1;

      if (w) {
        if (lastFlash !== undefined && w.flash && w.flash !== lastFlash) flashT = now;
        lastFlash = w.flash ?? 0;
      }
      for (const e of client.entities()) {
        if (e.kind !== 'weather:scorch' || seen.has(e.id)) continue;
        seen.add(e.id);
        if (now - flashT > 2500 || e.world !== me.world) continue;
        const [x, y] = screen(e.x + 0.5, e.y + 0.5);
        bolts.push({ points: boltTo(x, y), t: now });
        flashT = now;
      }
      if (seen.size > 200) seen.clear();
      for (let i = bolts.length - 1; i >= 0; i--) {
        const b = bolts[i];
        const age = (now - b.t) / 320;
        if (age >= 1) {
          bolts.splice(i, 1);
          continue;
        }
        g.globalAlpha = age < 0.3 ? 1 : 1 - (age - 0.3) / 0.7;
        for (const [width, colour] of [[6, 'rgba(150,180,255,0.35)'], [2, '#f4f7ff']] as const) {
          g.lineWidth = width;
          g.strokeStyle = colour;
          g.beginPath();
          b.points.forEach(([x, y], n) => (n ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.stroke();
        }
        g.globalAlpha = 1;
        g.lineWidth = 1;
      }
      const fl = flashAt(now - flashT);
      if (fl > 0) {
        g.fillStyle = `rgba(226,234,255,${(fl * (0.45 + night * 0.4)).toFixed(3)})`;
        g.fillRect(0, 0, W, H);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      client.setDarkness('weather', 0);
    };
  }, [client]);
  return <canvas className="weather-sky" ref={canvas} />;
}

const LOOK: Record<Sky, [string, string] | undefined> = {
  clear: undefined,
  cloudy: ['☁️', 'Overcast'],
  rain: ['🌧️', 'Rain'],
  storm: ['⛈️', 'Thunderstorm'],
  snow: ['🌨️', 'Snowfall'],
  blizzard: ['❄️', 'Blizzard'],
  fog: ['🌫️', 'Fog'],
  dust: ['🌪️', 'Duststorm'],
  ash: ['🌋', 'Ashfall'],
};

function Badge({ client }: { client: ClientAPI }) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  const w = outdoors(client) ? weatherOf(client.localPlayer()) : undefined;
  const look = w ? LOOK[w.sky] : undefined;
  if (!w || !look) return null;
  const label = w.sky === 'rain' && w.amount < 0.45 ? 'Drizzle' : w.sky === 'snow' && w.amount < 0.45 ? 'Flurries' : look[1];
  return (
    <div className="frame weather-badge" title="Fronts drift east across the land.">
      <span className="weather-icon">{look[0]}</span>
      <span>{label}</span>
    </div>
  );
}

export default defineClient({
  sprites: { 'weather:scorch': '💠' },
  interactions: {
    'weather:scorch': { intent: 'weather:dig', label: 'Dig' },
  },
  hud: { 'weather:badge': Badge },
  overlay: { 'weather:sky': SkyLayer },
});
