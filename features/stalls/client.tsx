import { useEffect, useReducer, useState, type KeyboardEvent, type ReactNode } from 'react';
import { defineClient, type ClientAPI, type EntityState } from '@game/shared';
import { KIND, MAX_GOODS, MAX_NAME, MAX_PRICE, RANGE, labelOf, type Good, type Stall } from './index.ts';
import './stalls.css';

const abs = (n: number): number => (n < 0 ? -n : n);

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

function nameOf(e: EntityState | undefined): string | undefined {
  const c = e?.components.character as { name?: unknown } | undefined;
  return typeof c?.name === 'string' ? c.name : undefined;
}

function goldOf(e: EntityState | undefined): number {
  const c = e?.components.character as { gold?: unknown } | undefined;
  return typeof c?.gold === 'number' ? c.gold : 0;
}

/** The closest stall within reach of the local player. */
function stallHere(client: ClientAPI): { e: EntityState; stall: Stall } | undefined {
  const me = client.localPlayer();
  if (!me) return undefined;
  let best: { e: EntityState; stall: Stall; d: number } | undefined;
  for (const e of client.entities()) {
    if (e.kind !== KIND || (e.world ?? 'overworld') !== (me.world ?? 'overworld')) continue;
    const d = abs(e.x - me.x) > abs(e.y - me.y) ? abs(e.x - me.x) : abs(e.y - me.y);
    const stall = e.components[KIND] as Stall | undefined;
    if (d <= RANGE && stall && (!best || d < best.d)) best = { e, stall, d };
  }
  return best;
}

const send = (client: ClientAPI, kind: string, extra: Record<string, unknown> = {}): void =>
  client.sendIntent({ t: 'intent', kind, ...extra });

const stop = (e: KeyboardEvent): void => e.stopPropagation();
const digits = (v: string, n: number): string => v.replace(/[^0-9]/g, '').slice(0, n);
const toInt = (v: string, lo: number, hi: number): number => {
  const n = Number.parseInt(v, 10);
  return !Number.isFinite(n) ? lo : n < lo ? lo : n > hi ? hi : n;
};

function NumberField({ value, onCommit, width = 52, max = 4 }: { value: number; onCommit: (n: number) => void; width?: number; max?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft !== null && draft !== '' && Number.parseInt(draft, 10) !== value) onCommit(Number.parseInt(draft, 10));
    setDraft(null);
  };
  return (
    <input
      className="stall-num"
      style={{ width }}
      inputMode="numeric"
      value={draft ?? String(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(digits(e.target.value, max))}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

function GoodRow({ client, g, children }: { client: ClientAPI; g: Good; children: ReactNode }) {
  return (
    <div className="stall-good">
      <span className="stall-icon">{client.itemIcon(g.itemId)}</span>
      <span className="stall-good-name">
        {client.itemDef(g.itemId)?.name ?? g.itemId}
        <span className="muted"> ×{g.count}</span>
      </span>
      {children}
    </div>
  );
}

function BuyRow({ client, stallId, g, index, gold }: { client: ClientAPI; stallId: number; g: Good; index: number; gold: number }) {
  const [n, setN] = useState(1);
  const qty = n > g.count ? g.count : n;
  const cost = qty * g.price;
  return (
    <GoodRow client={client} g={g}>
      <span className="stall-price">{g.price}g</span>
      {g.count > 1 && <NumberField value={qty} width={36} max={3} onCommit={(v) => setN(v < 1 ? 1 : v)} />}
      <button type="button" className="btn small" disabled={cost > gold} title={cost > gold ? 'Not enough gold' : undefined} onClick={() => send(client, 'stalls:buy', { stallId, index, count: qty })}>
        Buy · {cost}g
      </button>
    </GoodRow>
  );
}

function OwnerView({ client, e, stall }: { client: ClientAPI; e: EntityState; stall: Stall }) {
  const me = client.localPlayer();
  const [slot, setSlot] = useState<number | null>(null);
  const [count, setCount] = useState('');
  const [price, setPrice] = useState('');
  const [name, setName] = useState<string | null>(null);
  const slots = ((me?.components.inventory as { slots?: { itemId: string; count: number }[] } | undefined)?.slots ?? []).map((s, i) => ({ ...s, i })).filter((s) => s.count > 0 && s.itemId);
  const picked = slots.find((s) => s.i === slot);
  const def = picked ? client.itemDef(picked.itemId) : undefined;
  const suggested = def ? (def.value ?? 1) * 2 : 1;
  const full = stall.goods.length >= MAX_GOODS && !stall.goods.some((g) => g.itemId === picked?.itemId);
  return (
    <>
      <div className="stall-sign">
        <input
          className="stall-name"
          maxLength={MAX_NAME}
          placeholder={`${stall.owner}’s Stall`}
          value={name ?? stall.name ?? ''}
          onChange={(ev) => setName(ev.target.value)}
          onKeyDown={(ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') ev.currentTarget.blur();
          }}
          onBlur={() => {
            if (name !== null && name !== (stall.name ?? '')) send(client, 'stalls:name', { stallId: e.id, name });
            setName(null);
          }}
        />
      </div>
      <div className="stall-till">
        <span>
          Till: <b>{stall.till}g</b>
        </span>
        <button type="button" className="btn small" disabled={stall.till <= 0} onClick={() => send(client, 'stalls:collect', { stallId: e.id })}>
          Collect
        </button>
      </div>
      <div className="section-title">
        On sale ({stall.goods.length}/{MAX_GOODS})
      </div>
      {stall.goods.length === 0 && <div className="muted">Nothing yet. Pick something from your pack below.</div>}
      {stall.goods.map((g, i) => (
        <GoodRow key={`${g.itemId}:${g.price}`} client={client} g={g}>
          <NumberField value={g.price} max={4} onCommit={(v) => send(client, 'stalls:price', { stallId: e.id, index: i, price: v })} />
          <span className="muted">g</span>
          <button type="button" className="btn small" onClick={() => send(client, 'stalls:unstock', { stallId: e.id, index: i })}>
            Take back
          </button>
        </GoodRow>
      ))}
      <div className="section-title">Put up for sale</div>
      <div className="stall-pack">
        {slots.map((s) => (
          <button key={s.i} type="button" className={`stall-slot${s.i === slot ? ' on' : ''}`} title={client.itemDef(s.itemId)?.name} onClick={() => { setSlot(s.i); setCount(''); setPrice(''); }}>
            {client.itemIcon(s.itemId)}
            {s.count > 1 && <span className="stall-slot-n">{s.count}</span>}
          </button>
        ))}
      </div>
      <div className="stall-form">
        <span className="stall-what">{picked ? (def?.name ?? picked.itemId) : 'Pick an item from your pack'}</span>
        <label>
          Qty
          <input className="stall-num" inputMode="numeric" value={count === '' && picked ? String(picked.count) : count} onKeyDown={stop} onFocus={(ev) => ev.currentTarget.select()} onChange={(ev) => setCount(digits(ev.target.value, 3))} />
        </label>
        <label>
          Price
          <input className="stall-num" inputMode="numeric" value={price === '' ? String(suggested) : price} onKeyDown={stop} onFocus={(ev) => ev.currentTarget.select()} onChange={(ev) => setPrice(digits(ev.target.value, 4))} />
        </label>
        <button
          type="button"
          className="btn small"
          disabled={!picked || full}
          title={full ? `A stall holds ${MAX_GOODS} kinds of goods` : undefined}
          onClick={() => {
            if (!picked) return;
            send(client, 'stalls:stock', { stallId: e.id, slot: picked.i, count: count === '' ? picked.count : toInt(count, 1, picked.count), price: price === '' ? suggested : toInt(price, 1, MAX_PRICE) });
            setSlot(null);
          }}
        >
          Put on sale
        </button>
      </div>
      <div className="stall-foot">
        <button type="button" className="btn small danger" onClick={() => send(client, 'stalls:pack', { stallId: e.id })} title="Take the stall, its goods and the till back into your pack">
          Pack up stall
        </button>
      </div>
    </>
  );
}

function StallWindow({ client }: { client: ClientAPI }) {
  useLive(client);
  const here = stallHere(client);
  const me = client.localPlayer();
  if (!here) return <div className="stalls muted">Step up to a market stall to trade.</div>;
  const { e, stall } = here;
  const mine = stall.owner === nameOf(me);
  return (
    <div className="stalls">
      {mine ? (
        <OwnerView client={client} e={e} stall={stall} />
      ) : (
        <>
          <div className="stall-banner">
            <b>{labelOf(stall)}</b>
            <span className="muted"> · kept by {stall.owner}</span>
          </div>
          {stall.goods.length === 0 ? (
            <div className="muted">The shelves are bare. Come back later.</div>
          ) : (
            stall.goods.map((g, i) => <BuyRow key={`${g.itemId}:${g.price}:${i}`} client={client} stallId={e.id} g={g} index={i} gold={goldOf(me)} />)
          )}
          <div className="stall-gold muted">You carry {goldOf(me)} gold.</div>
        </>
      )}
    </div>
  );
}

export default defineClient({
  interactions: {
    [KIND]: { intent: 'stalls:browse', label: 'Browse', opens: 'stalls:stall' },
  },
  windows: {
    'stalls:stall': { title: 'Market Stall', icon: '⛺', component: StallWindow, onBar: false },
  },
});
