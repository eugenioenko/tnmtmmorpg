import { useEffect, useReducer } from 'react';
import { defineClient, type ClientAPI } from '@game/shared';
import type { DayTime } from './index.ts';
import './daynight.css';

function useTime(client: ClientAPI): DayTime | undefined {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  const raw = client.localPlayer()?.components['daynight:time'];
  return typeof raw === 'object' && raw !== null ? (raw as DayTime) : undefined;
}

function outdoors(client: ClientAPI): boolean {
  const w = client.localPlayer()?.world ?? 'overworld';
  return !w.startsWith('interior:') && !w.startsWith('dungeon:');
}

/** 0 at full day, 1 at deepest night; dusk 18-21, dawn 4-7. */
export function darkness(minute: number): number {
  const h = minute / 60;
  if (h >= 21 || h < 4) return 1;
  if (h >= 18) return (h - 18) / 3;
  if (h < 7) return 1 - (h - 4) / 3;
  return 0;
}

function NightShade({ client }: { client: ClientAPI }) {
  const t = useTime(client);
  if (!t || !outdoors(client)) return null;
  const d = darkness(t.minute);
  const dusk = t.minute >= 17 * 60 && t.minute < 20 * 60 ? 1 : 0;
  return (
    <>
      <div className="daynight-shade" style={{ opacity: d * 0.62 }} />
      <div className="daynight-dusk" style={{ opacity: dusk * (1 - d) * 0.35 }} />
    </>
  );
}

function phase(minute: number): [string, string] {
  const h = minute / 60;
  if (h < 5) return ['🌙', 'Night'];
  if (h < 8) return ['🌅', 'Dawn'];
  if (h < 12) return ['☀️', 'Morning'];
  if (h < 17) return ['☀️', 'Afternoon'];
  if (h < 21) return ['🌇', 'Evening'];
  return ['🌙', 'Night'];
}

function Clock({ client }: { client: ClientAPI }) {
  const t = useTime(client);
  if (!t) return null;
  const [icon, label] = phase(t.minute);
  const hh = String((t.minute / 60) | 0).padStart(2, '0');
  const mm = String(t.minute % 60).padStart(2, '0');
  return (
    <div className="frame daynight-clock" title={`Day ${t.day}. One hour passes every two minutes.`}>
      <span className="daynight-icon">{icon}</span>
      <span>{label}</span>
      <span className="daynight-time">
        {hh}:{mm}
      </span>
    </div>
  );
}

export default defineClient({
  hud: { 'daynight:clock': Clock },
  overlay: { 'daynight:shade': NightShade },
});
