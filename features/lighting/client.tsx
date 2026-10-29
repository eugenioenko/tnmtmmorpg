import { useEffect, useReducer, useRef } from 'react';
import { defineClient, type ClientAPI } from '@game/shared';
import { ITEMS } from './index.ts';
import './lighting.css';

/** A flame in the hand of everyone carrying a lit torch. */
function Carried({ client }: { client: ClientAPI }) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  const nodes = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    let frame = 0;
    const place = (): void => {
      for (const [id, el] of nodes.current) {
        const p = client.screenOf(id);
        el.style.visibility = p ? 'visible' : 'hidden';
        if (p) el.style.transform = `translate(${(p.x | 0) + 7}px, ${(p.y | 0) + 12}px)`;
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [client]);
  const ids: number[] = [];
  for (const e of client.entities()) if (e.components['lighting:held']) ids.push(e.id);
  return (
    <div className="lighting-layer">
      {ids.map((id) => (
        <div
          key={id}
          className="lighting-flame"
          ref={(el) => {
            if (el) nodes.current.set(id, el);
            else nodes.current.delete(id);
          }}
        >
          🔥
        </div>
      ))}
    </div>
  );
}

export default defineClient({
  items: ITEMS,
  sprites: {
    'lighting:planted': '🔥',
    'lighting:lamp': '🏮',
    'lighting:campfire': '🔥',
  },
  overlay: { 'lighting:carried': Carried },
});
