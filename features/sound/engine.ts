/**
 * The audio graph every sound shares: three buses (music, ambience, effects)
 * into a master gain, a send to one generated reverb, a white-noise buffer
 * for wind, water and crackle, and small helpers that schedule a single
 * voice at an exact time. Everything is synthesised; there are no samples.
 *
 * Works on any BaseAudioContext, so an OfflineAudioContext can render it.
 */

export interface Engine {
  ctx: BaseAudioContext;
  master: GainNode;
  music: GainNode;
  ambience: GainNode;
  sfx: GainNode;
  /** Send into the shared reverb. */
  verb: GainNode;
  noise: AudioBuffer;
}

let seed = 1779033703;
export function rand(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}

export function pick<T>(list: readonly T[]): T {
  return list[(rand() * list.length) | 0];
}

/** Equal-tempered frequency of every MIDI note. */
const FREQ: number[] = (() => {
  const out = new Array<number>(128);
  const semitone = 1.0594630943592953;
  out[69] = 440;
  for (let n = 70; n < 128; n++) out[n] = out[n - 1] * semitone;
  for (let n = 68; n >= 0; n--) out[n] = out[n + 1] / semitone;
  return out;
})();

export function hz(note: number): number {
  return FREQ[note < 0 ? 0 : note > 127 ? 127 : note | 0];
}

function impulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const length = (ctx.sampleRate * seconds) | 0;
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const fall = 1 - decay / ctx.sampleRate;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let amp = 1;
    for (let i = 0; i < length; i++) {
      data[i] = (rand() * 2 - 1) * amp;
      amp *= fall;
    }
  }
  return buffer;
}

export function createEngine(ctx: BaseAudioContext): Engine {
  const master = ctx.createGain();
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.ratio.value = 3;
  glue.attack.value = 0.01;
  glue.release.value = 0.3;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.8;
  master.connect(glue).connect(makeup).connect(ctx.destination);
  const bus = (level: number): GainNode => {
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(master);
    return g;
  };
  const music = bus(0.5);
  const ambience = bus(0.6);
  const sfx = bus(0.7);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx, 3.2, 2.2);
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  reverb.connect(wet).connect(master);
  const verb = ctx.createGain();
  verb.connect(reverb);
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1;
  return { ctx, master, music, ambience, sfx, verb, noise };
}

/** An attack/decay envelope on a fresh gain node. */
export function envelope(e: Engine, t: number, attack: number, peak: number, decay: number): GainNode {
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

/** Route a voice to a bus, with an optional reverb send. */
export function out(e: Engine, node: AudioNode, bus: AudioNode, send = 0): void {
  node.connect(bus);
  if (send > 0) {
    const s = e.ctx.createGain();
    s.gain.value = send;
    node.connect(s).connect(e.verb);
  }
}

export function tone(
  e: Engine,
  type: OscillatorType,
  freq: number,
  t: number,
  length: number,
  gain: GainNode,
): OscillatorNode {
  const osc = e.ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + length + 0.05);
  return osc;
}

export function noiseBurst(e: Engine, t: number, length: number, gain: GainNode): AudioBufferSourceNode {
  const src = e.ctx.createBufferSource();
  src.buffer = e.noise;
  src.loop = true;
  src.connect(gain);
  src.start(t, rand() * 1.5);
  src.stop(t + length + 0.05);
  return src;
}

export function filter(e: Engine, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = e.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}
