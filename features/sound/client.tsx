import { useEffect, useReducer } from 'react';
import { defineClient, OVERWORLD, WORLD_CENTER_X, WORLD_CENTER_Y, type ClientAPI, type EntityState } from '@game/shared';
import { createEngine, rand, type Engine } from './engine.ts';
import { Improviser } from './music.ts';
import { Bed, call } from './ambience.ts';
import { ZONES, zoneFor } from './zones.ts';
import { effect, type Effect } from './sfx.ts';
import './sound.css';

export interface Mix {
  master: number;
  music: number;
  ambience: number;
  sfx: number;
  muted: boolean;
}

const KEY = 'sound:mix-v1';
const DEFAULT_MIX: Mix = { master: 0.8, music: 0.6, ambience: 0.7, sfx: 0.8, muted: false };

function loadMix(): Mix {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_MIX, ...(JSON.parse(raw) as Partial<Mix>) } : DEFAULT_MIX;
  } catch {
    return DEFAULT_MIX;
  }
}

function saveMix(mix: Mix): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mix));
  } catch {
    // Private windows and blocked storage simply forget the mix.
  }
}

interface Layer {
  zone: string;
  gain: GainNode;
  player: Improviser;
  next: number;
}

/**
 * Listens to where the player is and keeps the music, the ambient beds and
 * the creature calls in step with it. One per page; created on the first
 * click or key press because browsers keep audio locked until then.
 */
class Director {
  readonly e: Engine;
  mix = loadMix();
  zone = '';
  private pending = '';
  private pendingSince = 0;
  private layers: Layer[] = [];
  private readonly wind: Bed;
  private readonly surf: Bed;
  private last = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: ClientAPI) {
    this.e = createEngine(new AudioContext());
    this.wind = new Bed(this.e, this.e.ambience, 'wind');
    this.surf = new Bed(this.e, this.e.ambience, 'surf');
    this.applyMix();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setMix(next: Partial<Mix>): void {
    this.mix = { ...this.mix, ...next };
    saveMix(this.mix);
    this.applyMix();
    for (const fn of this.listeners) fn();
  }

  private applyMix(): void {
    const t = this.e.ctx.currentTime;
    const m = this.mix;
    this.e.master.gain.setTargetAtTime(m.muted ? 0 : m.master, t, 0.1);
    this.e.music.gain.setTargetAtTime(m.music, t, 0.1);
    this.e.ambience.gain.setTargetAtTime(m.ambience, t, 0.1);
    this.e.sfx.gain.setTargetAtTime(m.sfx, t, 0.1);
  }

  private sample(me: EntityState): { tiles: string[]; water: number } {
    const tiles: string[] = [];
    let water = 0;
    let seen = 0;
    for (let dy = -6; dy <= 6; dy += 2) {
      for (let dx = -6; dx <= 6; dx += 2) {
        const kind = this.client.tileAt(me.x + dx, me.y + dy);
        seen++;
        if (kind === 'water') water++;
        if (dx >= -2 && dx <= 2 && dy >= -2 && dy <= 2) tiles.push(kind);
      }
    }
    return { tiles, water: water / seen };
  }

  private fireNear(me: EntityState): number {
    let best = 0;
    for (const e of this.client.entities()) {
      const light = e.components.light as { flicker?: number } | undefined;
      if (!light || (light.flicker ?? 0) < 0.5 || e.world !== me.world) continue;
      const d = (e.x - me.x) * (e.x - me.x) + (e.y - me.y) * (e.y - me.y);
      if (d <= 25) best = best > 1 - d / 30 ? best : 1 - d / 30;
    }
    return best;
  }

  tick(): void {
    const ctx = this.e.ctx;
    const now = ctx.currentTime;
    const dt = this.last === 0 ? 0 : now - this.last;
    this.last = now;
    const me = this.client.localPlayer();
    if (!me) return;
    const world = me.world ?? OVERWORLD;
    const near =
      world === OVERWORLD &&
      (me.x - WORLD_CENTER_X) * (me.x - WORLD_CENTER_X) + (me.y - WORLD_CENTER_Y) * (me.y - WORLD_CENTER_Y) < 26 * 26;
    const { tiles, water } = this.sample(me);
    const wanted = zoneFor(world, near, tiles);
    if (wanted !== this.pending) {
      this.pending = wanted;
      this.pendingSince = now;
    }
    if (wanted !== this.zone && (this.zone === '' || now - this.pendingSince > 2.5 || world !== OVERWORLD)) {
      this.switchTo(wanted, now);
    }
    const zone = ZONES[this.zone];
    if (!zone) return;
    const night = this.client.darkness() > 0.45;

    for (const layer of this.layers) {
      if (layer.next < now) layer.next = now + 0.05;
      while (layer.next < now + 0.6) layer.next += layer.player.play(ZONES[layer.zone].score, layer.next, night);
    }

    this.wind.set(zone.wind * (night ? 0.8 : 1));
    this.surf.set(world === OVERWORLD || world === 'water' ? water * 0.12 : 0);
    this.wind.update(now);
    this.surf.update(now);

    if (dt > 0 && dt < 1) {
      for (const rule of zone.calls) {
        if (rule.when === 'day' && night) continue;
        if (rule.when === 'night' && !night) continue;
        if (rand() < rule.rate * dt) call(this.e, rule.call, now + 0.05 + rand() * 0.3, this.e.ambience, 0.6 + rand() * 0.4);
      }
      const fire = this.fireNear(me);
      if (fire > 0 && rand() < 1.4 * dt) call(this.e, 'crackle', now + 0.05, this.e.ambience, fire);
    }
  }

  /** Crossfade: the old zone's music fades over a few bars while the new one rises. */
  private switchTo(zone: string, now: number): void {
    this.zone = zone;
    for (const layer of this.layers) {
      layer.gain.gain.cancelScheduledValues(now);
      layer.gain.gain.setValueAtTime(layer.gain.gain.value, now);
      layer.gain.gain.linearRampToValueAtTime(0, now + 4);
      const old = layer;
      setTimeout(() => {
        old.gain.disconnect();
        this.layers = this.layers.filter((l) => l !== old);
      }, 4500);
    }
    const gain = this.e.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + 4);
    gain.connect(this.e.music);
    this.layers.push({ zone, gain, player: new Improviser(this.e, gain), next: now + 0.3 });
    for (const fn of this.listeners) fn();
  }
}

interface Seen {
  x: number;
  y: number;
  world: string;
  level: number;
  gold: number;
  items: number;
  work: number;
  skill: string;
  torch: boolean;
  hp: Map<number, number>;
}

function count(e: EntityState): number {
  const inv = e.components.inventory as { slots?: { count: number }[] } | undefined;
  let n = 0;
  for (const s of inv?.slots ?? []) n += s.count;
  return n;
}

/**
 * Turns snapshot-to-snapshot changes into sound: your steps on whatever
 * ground you cross, swings landing on trees and veins, blows traded nearby,
 * level-ups, coin and loot, a torch catching, a door or portal crossed.
 */
class Listener {
  private seen: Seen | null = null;

  constructor(
    private readonly client: ClientAPI,
    private readonly d: Director,
  ) {}

  private play(kind: Effect, vel = 1, ground?: string, delay = 0): void {
    const ctx = this.d.e.ctx;
    if ((ctx as AudioContext).state !== 'running') return;
    effect(this.d.e, kind, ctx.currentTime + 0.02 + delay, vel, ground);
  }

  observe(): void {
    const me = this.client.localPlayer();
    if (!me) return;
    const world = me.world ?? OVERWORLD;
    const character = me.components.character as { gold?: number } | undefined;
    const stats = me.components.stats as { level?: number } | undefined;
    const work = me.components['professions:work'] as { n?: number; skill?: string } | undefined;
    const hp = new Map<number, number>();
    for (const e of this.client.entities()) {
      const s = e.components.stats as { hp?: number } | undefined;
      if (typeof s?.hp === 'number' && (e.world ?? OVERWORLD) === world) hp.set(e.id, s.hp);
    }
    const now: Seen = {
      x: me.x,
      y: me.y,
      world,
      level: stats?.level ?? 0,
      gold: character?.gold ?? 0,
      items: count(me),
      work: work?.n ?? 0,
      skill: work?.skill ?? '',
      torch: me.components['lighting:held'] !== undefined,
      hp,
    };
    const was = this.seen;
    this.seen = now;
    if (!was) return;

    if (now.world !== was.world) {
      this.play('travel');
      return;
    }
    const moved = (now.x - was.x) * (now.x - was.x) + (now.y - was.y) * (now.y - was.y);
    if (moved > 0 && moved <= 8) this.play('step', 1, this.client.tileAt(now.x, now.y));
    const swing = was.skill === 'mining' ? 'mine' : 'chop';
    if (was.work && now.work && now.work !== was.work) this.play(swing);
    else if (was.work && !now.work && moved === 0) this.play(swing, 0.9);
    if (now.level > was.level && was.level > 0) this.play('levelup');
    if (now.gold > was.gold) this.play('coins');
    else if (now.items > was.items) this.play('pickup');
    if (now.torch && !was.torch) this.play('whoosh');

    for (const [id, value] of now.hp) {
      const before = was.hp.get(id);
      if (before === undefined || value >= before) continue;
      const e = this.client.entity(id);
      if (!e) continue;
      const d2 = (e.x - me.x) * (e.x - me.x) + (e.y - me.y) * (e.y - me.y);
      if (d2 > 144) continue;
      const vel = 1 - d2 / 160;
      if (id === me.id) this.play('hurt');
      else this.play(value <= 0 ? 'fall' : 'hit', vel);
    }
  }
}

let director: Director | null = null;
const waiting = new Set<() => void>();

function useDirector(): Director | null {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    waiting.add(force);
    const off = director?.onChange(force);
    return () => {
      waiting.delete(force);
      off?.();
    };
  }, []);
  return director;
}

/** Starts the audio on the first gesture and runs the director a few times a second. */
function SoundHost({ client }: { client: ClientAPI }) {
  useEffect(() => {
    let timer = 0;
    let unsubscribe: (() => void) | null = null;
    const start = (): void => {
      if (!director) {
        try {
          director = new Director(client);
        } catch {
          return;
        }
        for (const fn of waiting) fn();
        timer = window.setInterval(() => director?.tick(), 200);
        const ears = new Listener(client, director);
        unsubscribe = client.subscribe(() => ears.observe());
      }
      const ctx = director.e.ctx as AudioContext;
      if (ctx.state === 'suspended') void ctx.resume();
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
    return () => {
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [client]);
  return null;
}

const SLIDERS: { key: keyof Omit<Mix, 'muted'>; label: string }[] = [
  { key: 'master', label: 'Master' },
  { key: 'music', label: 'Music' },
  { key: 'ambience', label: 'Ambience' },
  { key: 'sfx', label: 'Effects' },
];

function SoundWindow() {
  const d = useDirector();
  if (!d) return <div className="sound-panel muted">Click anywhere in the world to wake the music.</div>;
  const zone = ZONES[d.zone];
  return (
    <div className="sound-panel">
      <div className="sound-now">
        <span>♪ Now playing</span>
        <b>{zone ? zone.name : '…'}</b>
      </div>
      {SLIDERS.map((s) => (
        <label key={s.key} className="sound-row">
          <span>{s.label}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={d.mix[s.key]}
            onChange={(ev) => d.setMix({ [s.key]: Number(ev.target.value) })}
          />
        </label>
      ))}
      <button className="btn small sound-mute" onClick={() => d.setMix({ muted: !d.mix.muted })}>
        {d.mix.muted ? '🔇 Unmute' : '🔊 Mute'}
      </button>
    </div>
  );
}

export default defineClient({
  overlay: { 'sound:host': SoundHost },
  windows: {
    'sound:mixer': { title: 'Sound', icon: '🎵', hotkey: 'KeyM', order: 95, component: SoundWindow },
  },
});
