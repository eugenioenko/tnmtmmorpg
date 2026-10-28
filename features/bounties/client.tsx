import { useEffect, useReducer, useState, type KeyboardEvent } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import { KIND, MAX_EACH, MAX_MINE, MAX_WANT, RANGE, type Board, type Bounty } from './index.ts';
import './bounties.css';

const abs = (n: number): number => (n < 0 ? -n : n);

/** What the board said when it was last in view, so it can be read from afar. */
let seen: { board: Board; catalog: string[]; at: number } | undefined;

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

function boardNear(client: ClientAPI): EntityState | undefined {
  for (const e of client.entities()) if (e.kind === KIND) return e;
  return undefined;
}

function nameOf(e: EntityState | undefined): string | undefined {
  const c = e?.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : undefined;
}

function goldOf(e: EntityState | undefined): number {
  const c = e?.components.character as { gold?: unknown } | undefined;
  return typeof c?.gold === 'number' ? c.gold : 0;
}

function carried(e: EntityState | undefined, itemId: string): number {
  const inv = e?.components.inventory as { slots?: { itemId: string; count: number }[] } | undefined;
  return (inv?.slots ?? []).reduce((n, s) => (s.itemId === itemId ? n + s.count : n), 0);
}

function ago(ms: number): string {
  const m = (ms / 60_000) | 0;
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${(m / 60) | 0} h ago`;
}

function left(ms: number): string {
  const m = (ms / 60_000) | 0;
  return m < 60 ? `${m < 1 ? 1 : m} min left` : `${(m / 60) | 0} h ${m % 60} min left`;
}

const send = (client: ClientAPI, kind: string, extra: Record<string, unknown> = {}): void =>
  client.sendIntent({ t: 'intent', kind, ...extra });

function Row({ client, b, me, at }: { client: ClientAPI; b: Bounty; me: EntityState | undefined; at: boolean }) {
  const def = client.itemDef(b.itemId);
  const mine = !b.town && b.by === nameOf(me);
  const have = carried(me, b.itemId);
  const need = b.want - b.got;
  const give = have < need ? have : need;
  const pct = b.want > 0 ? (b.got / b.want) * 100 : 100;
  return (
    <div className={`bounty${b.town ? ' town' : ''}${mine ? ' mine' : ''}${need <= 0 ? ' filled' : ''}`}>
      <div className="bounty-icon">{client.itemIcon(b.itemId)}</div>
      <div className="bounty-body">
        <div className="bounty-head">
          <span className="bounty-item">{def?.name ?? b.itemId}</span>
          <span className="bounty-count">
            {b.got}/{b.want}
          </span>
          <span className="bounty-pay">
            {b.each}g each{b.xp ? ` · ${b.xp} XP` : ''}
          </span>
        </div>
        <div className="bounty-track">
          <div className="bounty-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="bounty-foot">
          <span className="muted">
            {mine ? 'Your bounty' : b.by} · {b.until ? left(b.until - Date.now()) : ago(Date.now() - b.at)}
          </span>
          {mine ? (
            <span className="bounty-actions">
              {b.stash > 0 && (
                <button type="button" className="btn small" disabled={!at} onClick={() => send(client, 'bounties:collect', { id: b.id })}>
                  Collect {b.stash}
                </button>
              )}
              {need > 0 && (
                <button type="button" className="btn small danger" disabled={!at} title={`Refunds ${need * b.each} gold`} onClick={() => send(client, 'bounties:withdraw', { id: b.id })}>
                  Withdraw
                </button>
              )}
            </span>
          ) : (
            need > 0 && (
              <button type="button" className="btn small" disabled={!at || give <= 0} title={give > 0 ? `+${give * b.each} gold` : 'You carry none'} onClick={() => send(client, 'bounties:deliver', { id: b.id })}>
                {give > 0 ? `Deliver ${give} · +${give * b.each}g` : 'Deliver'}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function clampInt(raw: string, lo: number, hi: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function PostForm({ client, catalog, at, open }: { client: ClientAPI; catalog: string[]; at: boolean; open: number }) {
  const [itemId, setItem] = useState<string>('');
  const [want, setWant] = useState('5');
  const [each, setEach] = useState('');
  const def = itemId ? client.itemDef(itemId) : undefined;
  const suggested = def ? ((def.value ?? 1) * 3 + 1) >> 1 : 1;
  const nWant = clampInt(want, 1, MAX_WANT);
  const nEach = each === '' ? suggested : clampInt(each, 1, MAX_EACH);
  const total = nWant * nEach;
  const gold = goldOf(client.localPlayer());
  const stop = (e: KeyboardEvent): void => e.stopPropagation();
  return (
    <div className="bounty-post">
      <div className="bounty-picker">
        {catalog.map((id) => (
          <button
            key={id}
            type="button"
            className={`bounty-pick${id === itemId ? ' on' : ''}`}
            title={client.itemDef(id)?.name ?? id}
            onClick={() => {
              setItem(id);
              setEach('');
            }}
          >
            {client.itemIcon(id)}
          </button>
        ))}
      </div>
      <div className="bounty-form">
        <span className="bounty-what">{def ? def.name : 'Pick what you want brought'}</span>
        <label>
          Qty
          <input inputMode="numeric" value={want} onKeyDown={stop} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setWant(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} />
        </label>
        <label>
          Each
          <input inputMode="numeric" value={each === '' ? String(suggested) : each} onKeyDown={stop} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setEach(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} />
        </label>
        <button
          type="button"
          className="btn small"
          disabled={!at || !def || total > gold || open >= MAX_MINE}
          title={open >= MAX_MINE ? `At most ${MAX_MINE} open bounties` : total > gold ? 'Not enough gold' : `The board holds ${total} gold until goods arrive`}
          onClick={() => send(client, 'bounties:post', { itemId, want: nWant, each: nEach })}
        >
          Post · {total}g
        </button>
      </div>
    </div>
  );
}

function BoardWindow({ client }: { client: ClientAPI }) {
  useLive(client);
  const me = client.localPlayer();
  const e = boardNear(client);
  const live = e?.components['bounties:board'] as Board | undefined;
  const cat = e?.components['bounties:catalog'];
  if (live && Array.isArray(live.posts)) seen = { board: live, catalog: Array.isArray(cat) ? (cat as string[]) : (seen?.catalog ?? []), at: Date.now() };
  const at = !!(e && me && (me.world ?? 'overworld') === (e.world ?? 'overworld') && abs(me.x - e.x) <= RANGE && abs(me.y - e.y) <= RANGE);
  if (!seen) {
    return (
      <div className="bounties" style={{ width: 360 }}>
        <div className="muted">The bounty board stands in the village square. Walk up to it to read what folk are asking for.</div>
      </div>
    );
  }
  const name = nameOf(me);
  const posts = seen.board.posts;
  const town = posts.filter((p) => p.town);
  const mine = posts.filter((p) => !p.town && p.by === name);
  const others = posts.filter((p) => !p.town && p.by !== name && p.got < p.want);
  const open = mine.filter((p) => p.got < p.want).length;
  return (
    <div className="bounties" style={{ width: 380 }}>
      {!at && <div className="bounty-away">As pinned {ago(Date.now() - seen.at)}. Go to the board in the village square to deliver or post.</div>}
      <div className="section-title">Village notices</div>
      {town.length === 0 ? <div className="muted">Nothing from the village right now.</div> : town.map((b) => <Row key={b.id} client={client} b={b} me={me} at={at} />)}
      <div className="section-title">Wanted by adventurers</div>
      {others.length === 0 ? <div className="muted">No one has asked for anything. Be the first.</div> : others.map((b) => <Row key={b.id} client={client} b={b} me={me} at={at} />)}
      {mine.length > 0 && <div className="section-title">Your bounties</div>}
      {mine.map((b) => (
        <Row key={b.id} client={client} b={b} me={me} at={at} />
      ))}
      <div className="section-title">Post a bounty</div>
      <PostForm client={client} catalog={seen.catalog} at={at} open={open} />
    </div>
  );
}

export default defineClient({
  interactions: {
    [KIND]: { intent: 'bounties:read', label: 'Read', opens: 'bounties:board' },
  },
  windows: {
    'bounties:board': { title: 'Bounty Board', icon: '📜', hotkey: 'KeyB', component: BoardWindow, order: 60 },
  },
});
