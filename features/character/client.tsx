import { useEffect, useReducer, useRef, useState } from 'react';
import { defineClient, isStatsComponent, type ClientAPI, type EntityState } from '@game/shared';
import { ITEMS } from './index.ts';

interface CharacterView {
  name: string;
  xp: number;
  xpPrev: number;
  xpNext: number;
  gold: number;
  kills: number;
  deaths: number;
  equipment: { weapon?: string; armor?: string; charm?: string };
  log: { n: number; text: string; tone: string }[];
}

const TOKEN_KEY = 'tnmt:character-token';

function character(e: EntityState | undefined): CharacterView | undefined {
  const c = e?.components.character;
  return typeof c === 'object' && c !== null && typeof (c as CharacterView).name === 'string'
    ? (c as CharacterView)
    : undefined;
}

function usePlayer(client: ClientAPI): EntityState | undefined {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
  return client.localPlayer();
}

function loadToken(): string {
  try {
    const existing = localStorage.getItem(TOKEN_KEY);
    if (existing && /^[a-z0-9]{16,64}$/.test(existing)) return existing;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(TOKEN_KEY, token);
    return token;
  } catch {
    return '';
  }
}

/**
 * Invisible HUD agent: claims this browser's saved character whenever the
 * connection gets a new entity, and relays the character's log lines into
 * the message log (deaths also get a banner).
 */
function CharacterAgent({ client }: { client: ClientAPI }) {
  const claimed = useRef<number | null>(null);
  const seen = useRef<number>(-1);
  useEffect(
    () =>
      client.subscribe(() => {
        const me = client.localPlayer();
        if (!me) return;
        if (claimed.current !== me.id) {
          claimed.current = me.id;
          seen.current = -1;
          const token = loadToken();
          if (token) client.sendIntent({ t: 'intent', kind: 'character:claim', token });
        }
        const c = character(me);
        if (!c) return;
        const lines = c.log ?? [];
        if (seen.current < 0) {
          seen.current = lines[lines.length - 1]?.n ?? 0;
          for (const line of lines.slice(-2)) client.notify(line.text, toTone(line.tone));
          return;
        }
        for (const line of lines) {
          if (line.n <= seen.current) continue;
          seen.current = line.n;
          client.notify(line.text, toTone(line.tone));
          if (line.tone === 'death') client.banner('You have fallen', 'You wake in the village square.', 'death');
        }
      }),
    [client],
  );
  return null;
}

function toTone(tone: string): 'info' | 'good' | 'bad' | 'loot' | 'quest' | 'level' {
  if (tone === 'death') return 'bad';
  return (['info', 'good', 'bad', 'loot', 'quest', 'level'] as const).find((t) => t === tone) ?? 'info';
}

const SLOT_LABEL = { weapon: 'Weapon', armor: 'Armor', charm: 'Charm' } as const;

function CharacterSheet({ client }: { client: ClientAPI }) {
  const me = usePlayer(client);
  const [renaming, setRenaming] = useState<string | null>(null);
  const c = character(me);
  const stats = me?.components.stats;
  if (!c || !isStatsComponent(stats)) return <div className="muted">No character yet.</div>;
  return (
    <div style={{ width: 300 }}>
      <div className="section-title">Identity</div>
      {renaming === null ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ flex: 1, font: '600 16px var(--font-title)', color: 'var(--gold-hi)' }}>{c.name}</span>
          <button type="button" className="btn small" onClick={() => setRenaming(c.name)}>
            Rename
          </button>
          <button
            type="button"
            className="btn small"
            title="Change your look"
            onClick={() => client.sendIntent({ t: 'intent', kind: 'character:look', step: 1 })}
          >
            Look ›
          </button>
        </div>
      ) : (
        <form
          style={{ display: 'flex', gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            client.sendIntent({ t: 'intent', kind: 'character:rename', name: renaming });
            setRenaming(null);
          }}
        >
          <input
            autoFocus
            value={renaming}
            maxLength={24}
            onChange={(e) => setRenaming(e.target.value)}
            style={{
              flex: 1,
              background: '#120d08',
              border: '1px solid var(--gold-lo)',
              borderRadius: 4,
              color: 'var(--ink)',
              padding: '3px 6px',
              font: 'inherit',
            }}
          />
          <button type="submit" className="btn small">
            Save
          </button>
        </form>
      )}

      <div className="section-title">Attributes</div>
      <div className="kv">
        <span className="k">Level</span>
        <span className="v">{stats.level}</span>
        <span className="k">Experience</span>
        <span className="v">
          {c.xp} / {c.xpNext}
        </span>
        <span className="k">Health</span>
        <span className="v">
          {stats.hp} / {stats.maxHp}
        </span>
        <span className="k">Attack</span>
        <span className="v">{stats.atk}</span>
        <span className="k">Defense</span>
        <span className="v">{stats.def}</span>
        <span className="k">Gold</span>
        <span className="v" style={{ color: 'var(--loot)' }}>
          {c.gold}
        </span>
        <span className="k">Creatures slain</span>
        <span className="v">{c.kills}</span>
        <span className="k">Times fallen</span>
        <span className="v">{c.deaths}</span>
      </div>

      <div className="section-title">Equipment</div>
      {(['weapon', 'armor', 'charm'] as const).map((slot) => {
        const id = c.equipment[slot];
        const def = id ? ITEMS.find((i) => i.id === id) : undefined;
        return (
          <div key={slot} className="equip-row">
            <div className="icon">{def?.icon ?? '·'}</div>
            <div>
              <div className="slot-name">{SLOT_LABEL[slot]}</div>
              <div className="item-name">{def?.name ?? <span className="muted">Nothing</span>}</div>
            </div>
            {def && (
              <button
                type="button"
                className="btn small"
                style={{ marginLeft: 'auto' }}
                onClick={() => client.sendIntent({ t: 'intent', kind: 'character:unequip', slot })}
              >
                Remove
              </button>
            )}
          </div>
        );
      })}
      <div className="hint" style={{ marginTop: 6 }}>
        Equip weapons, armor and charms from your inventory.
      </div>
    </div>
  );
}

export default defineClient({
  items: ITEMS,
  hud: { 'character:agent': CharacterAgent },
  windows: {
    'character:sheet': {
      title: 'Character',
      icon: '🛡️',
      hotkey: 'KeyC',
      order: 5,
      component: CharacterSheet,
    },
  },
});
