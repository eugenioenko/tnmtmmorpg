export type Sky = 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'blizzard' | 'fog' | 'dust' | 'ash';

/** The private `weather:here` component: what the sky is doing over one player. */
export interface Weather {
  sky: Sky;
  /** 0..1 within the sky: drizzle to downpour, flurries to whiteout. */
  amount: number;
  /** 0..1; everything blows east. */
  wind: number;
  /** Epoch ms of the latest lightning over this player. */
  flash?: number;
}

const floor = (v: number): number => {
  const i = v | 0;
  return v < i ? i - 1 : i;
};

function hash(x: number, y: number, z: number): number {
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function value3(x: number, y: number, z: number): number {
  const x0 = floor(x);
  const y0 = floor(y);
  const z0 = floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);
  const plane = (zz: number): number =>
    lerp(
      lerp(hash(x0, y0, zz), hash(x0 + 1, y0, zz), fx),
      lerp(hash(x0, y0 + 1, zz), hash(x0 + 1, y0 + 1, zz), fx),
      fy,
    );
  return lerp(plane(z0), plane(z0 + 1), fz);
}

/**
 * How wet the sky is over (x, y) at `ms`, 0..1. Two layers of noise drift
 * east at different speeds while slowly changing shape, so fronts roll in
 * across the map and you can walk out from under a storm.
 */
export function wetness(x: number, y: number, ms: number): number {
  const m = ms / 60000;
  return 0.65 * value3(x / 110 - m * 0.08, y / 110, m / 12) + 0.35 * value3(x / 45 - m * 0.2, y / 45 + 100, m / 5);
}

export function fogginess(x: number, y: number, ms: number): number {
  const m = ms / 60000;
  return value3(x / 70 - m * 0.04, y / 70 + 500, m / 7);
}

/** Thresholds on wetness: roughly a third of the sky is overcast, a fifth rains and one part in fifteen storms. */
export const CLOUDY = 0.55;
export const RAIN = 0.62;
export const STORM = 0.71;
export const FOG = 0.76;

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The weather over one spot. `tile` is the ground underfoot and `hour` the time of day. */
export function skyAt(world: string, tile: string, x: number, y: number, ms: number, hour: number): Weather {
  const w = wetness(x, y, ms);
  const wind = clamp(0.25 + (w - 0.4) * 1.6);
  const dawn = hour >= 4 && hour < 9;
  const rainy = (): Weather =>
    w >= STORM
      ? { sky: 'storm', amount: clamp(0.7 + (w - STORM) * 4), wind }
      : { sky: 'rain', amount: clamp(0.25 + ((w - RAIN) / (STORM - RAIN)) * 0.5), wind };
  const misty = (bias: number): Weather | undefined => {
    const f = fogginess(x, y, ms) + bias + (dawn ? 0.12 : 0);
    return f >= FOG ? { sky: 'fog', amount: clamp(0.35 + (f - FOG) * 3), wind: wind * 0.4 } : undefined;
  };
  const clouds = (): Weather =>
    w >= CLOUDY ? { sky: 'cloudy', amount: clamp((w - CLOUDY) / (RAIN - CLOUDY)), wind } : { sky: 'clear', amount: 0, wind };

  if (world === 'snow') {
    return w >= STORM ? { sky: 'blizzard', amount: clamp(0.6 + (w - STORM) * 4), wind: 1 } : { sky: 'snow', amount: clamp(0.3 + w * 0.5), wind };
  }
  if (world === 'fire') return { sky: 'ash', amount: clamp(0.35 + w * 0.6), wind };
  if (world === 'water') return w >= RAIN ? rainy() : (misty(0.15) ?? clouds());
  if (world === 'verdant') return w >= RAIN ? rainy() : (misty(0.05) ?? clouds());
  if (world !== 'overworld') return { sky: 'clear', amount: 0, wind: 0 };

  if (tile === 'snow') {
    if (w >= STORM) return { sky: 'blizzard', amount: clamp(0.6 + (w - STORM) * 4), wind: 1 };
    if (w >= RAIN) return { sky: 'snow', amount: clamp(0.3 + ((w - RAIN) / (STORM - RAIN)) * 0.5), wind };
    return clouds();
  }
  if (tile === 'sand') {
    if (w >= STORM) return { sky: 'dust', amount: clamp(0.5 + (w - STORM) * 4), wind: 1 };
    return clouds();
  }
  if (w >= RAIN) return rainy();
  return misty(tile === 'swamp' ? 0.12 : tile === 'water' ? 0.05 : 0) ?? clouds();
}
