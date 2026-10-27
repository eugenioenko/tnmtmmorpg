import { useEffect, useReducer, useState } from 'react';
import { defineClient, type ClientAPI, type InventoryComponent } from '@game/shared';
import type { TradeState } from './index.ts';
import './trade.css';

function useLive(client: ClientAPI): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => client.subscribe(force), [client]);
}

function tradeState(client: ClientAPI): TradeState {
  const raw = client.localPlayer()?.components['trade:state'];
  return typeof raw === 'object' && raw !== null ? (raw as TradeState) : {};
}

function inventory(client: ClientAPI): InventoryComponent | undefined {
  const inv = client.localPlayer()?.components.inventory as InventoryComponent | undefined;
  return inv && Array.isArray(inv.slots) ? inv : undefined;
}

function gold(client: ClientAPI): number {
  const c = client.localPlayer()?.components.character as { gold?: unknown } | undefined;
  return typeof c?.gold === 'number' ? c.gold : 0;
}

const send = (client: ClientAPI, kind: string, extra: Record<string, unknown> = {}): void =>
  client.sendIntent({ t: 'intent', kind, ...extra });

/** Relays trade outcomes into the message log, once each. */
function useNotices(client: ClientAPI): void {
  useEffect(() => {
    let owner: number | null = null;
    let seen = 0;
    return client.subscribe(() => {
      const me = client.localPlayer();
      if (!me) return;
      const notice = tradeState(client).notice;
      if (me.id !== owner) {
        owner = me.id;
        seen = notice?.n ?? 0;
        return;
      }
      if (notice && notice.n > seen) {
        seen = notice.n;
        client.notify(notice.text, notice.tone);
      }
    });
  }, [client]);
}

function Slot({
  client,
  itemId,
  count,
  onClick,
  title,
  dim,
}: {
  client: ClientAPI;
  itemId?: string;
  count?: number;
  onClick?: () => void;
  title?: string;
  dim?: boolean;
}) {
  const def = itemId ? client.itemDef(itemId) : undefined;
  return (
    <button
      type="button"
      className={`trade-slot${itemId ? ' filled' : ''}${dim ? ' dim' : ''}`}
      title={title ?? def?.name}
      disabled={!onClick}
      onClick={(e) => {
        e.currentTarget.blur();
        onClick?.();
      }}
    >
      {itemId && <span className="glyph">{client.itemIcon(itemId)}</span>}
      {itemId && count !== undefined && count > 1 && <span className="count">{count}</span>}
    </button>
  );
}

function OfferGrid({
  client,
  items,
  onRemove,
}: {
  client: ClientAPI;
  items: { itemId: string; count: number }[];
  onRemove?: (index: number) => void;
}) {
  return (
    <div className="trade-grid">
      {Array.from({ length: 8 }, (_, i) => {
        const item = items[i];
        const def = item ? client.itemDef(item.itemId) : undefined;
        return (
          <Slot
            key={i}
            client={client}
            itemId={item?.itemId}
            count={item?.count}
            title={def ? `${def.name}${onRemove ? ' (click to take back)' : ''}` : undefined}
            onClick={item && onRemove ? () => onRemove(i) : undefined}
          />
        );
      })}
    </div>
  );
}

function GoldField({ client, value }: { client: ClientAPI; value: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    const amount = Number.parseInt(draft, 10);
    send(client, 'trade:gold', { amount: Number.isFinite(amount) && amount > 0 ? amount : 0 });
    setDraft(null);
  };
  return (
    <label className="trade-gold">
      <span className="coin">◉</span>
      <input
        inputMode="numeric"
        value={draft ?? String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <span className="muted">of {gold(client)}</span>
    </label>
  );
}

function TradeWindow({ client }: { client: ClientAPI }) {
  const session = tradeState(client).session;
  const inv = inventory(client);
  if (!session) return null;
  const { mine, theirs } = session;
  const offeredBySlot = new Map(mine.items.map((i) => [i.slot, i.count]));
  const bothLocked = mine.locked && theirs.locked;
  let status = 'Put up items and gold, then lock your offer.';
  if (mine.locked && !theirs.locked) status = `Waiting for ${session.partnerName} to lock their offer…`;
  else if (!mine.locked && theirs.locked) status = `${session.partnerName} has locked their offer.`;
  else if (bothLocked && mine.accepted) status = `Waiting for ${session.partnerName} to accept…`;
  else if (bothLocked && theirs.accepted) status = `${session.partnerName} accepted. Your turn.`;
  else if (bothLocked) status = 'Both offers locked. Review and accept.';

  return (
    <div className="trade-window window frame" onPointerDown={(e) => e.stopPropagation()}>
      <div className="window-title">
        <span>⚖️</span>
        <span>Trading with {session.partnerName}</span>
        <span className="spacer" />
        <button type="button" className="close-btn" onClick={() => send(client, 'trade:cancel')}>
          ✕
        </button>
      </div>
      <div className="window-body">
        <div className="trade-sides">
          <div className={`trade-side${mine.locked ? ' locked' : ''}`}>
            <div className="section-title">
              Your offer {mine.accepted ? <b className="ok">✓ accepted</b> : mine.locked ? <b>🔒 locked</b> : null}
            </div>
            <OfferGrid
              client={client}
              items={mine.items}
              onRemove={(index) => send(client, 'trade:remove-item', { index })}
            />
            <GoldField client={client} value={mine.gold} />
          </div>
          <div className={`trade-side${theirs.locked ? ' locked' : ''}`}>
            <div className="section-title">
              {session.partnerName}{' '}
              {theirs.accepted ? <b className="ok">✓ accepted</b> : theirs.locked ? <b>🔒 locked</b> : null}
            </div>
            <OfferGrid client={client} items={theirs.items} />
            <div className="trade-gold">
              <span className="coin">◉</span>
              <span className="their-gold">{theirs.gold}</span>
            </div>
          </div>
        </div>

        <div className="section-title">Your pack · click to offer, right-click for one</div>
        <div className="trade-pack">
          {(inv?.slots ?? []).map((cell, slot) => {
            const offered = offeredBySlot.get(slot);
            const filled = cell.count > 0;
            return (
              <div
                key={slot}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (filled) send(client, 'trade:offer-item', { slot, count: (offered ?? 0) + 1 });
                }}
              >
                <Slot
                  client={client}
                  itemId={filled ? cell.itemId : undefined}
                  count={filled ? cell.count - (offered ?? 0) : undefined}
                  dim={offered !== undefined && offered >= cell.count}
                  onClick={filled ? () => send(client, 'trade:offer-item', { slot }) : undefined}
                />
              </div>
            );
          })}
        </div>

        <div className="trade-status">{status}</div>
        <div className="trade-actions">
          <button
            type="button"
            className="btn"
            onClick={() => send(client, 'trade:lock', { locked: !mine.locked })}
          >
            {mine.locked ? 'Unlock' : 'Lock offer'}
          </button>
          <button
            type="button"
            className="btn accept"
            disabled={!bothLocked || mine.accepted}
            onClick={() => send(client, 'trade:accept')}
          >
            Accept trade
          </button>
          <span className="spacer" />
          <button type="button" className="btn danger" onClick={() => send(client, 'trade:cancel')}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Requests({ client }: { client: ClientAPI }) {
  const { incoming, outgoing, session } = tradeState(client);
  if (session) return null;
  if (incoming) {
    return (
      <div className="trade-request frame" onPointerDown={(e) => e.stopPropagation()}>
        <div>
          <b>{incoming.fromName}</b> wants to trade with you.
        </div>
        <div className="trade-actions">
          <button
            type="button"
            className="btn accept"
            onClick={() => send(client, 'trade:respond', { accept: true })}
          >
            Trade
          </button>
          <button type="button" className="btn" onClick={() => send(client, 'trade:respond', { accept: false })}>
            Decline
          </button>
        </div>
      </div>
    );
  }
  if (outgoing) {
    return (
      <div className="trade-request frame small" onPointerDown={(e) => e.stopPropagation()}>
        <div>
          Asking <b>{outgoing.toName}</b> to trade…
        </div>
        <button type="button" className="btn small" onClick={() => send(client, 'trade:cancel')}>
          Cancel
        </button>
      </div>
    );
  }
  return null;
}

function TradeLayer({ client }: { client: ClientAPI }) {
  useLive(client);
  useNotices(client);
  return (
    <>
      <Requests client={client} />
      <TradeWindow client={client} />
    </>
  );
}

export default defineClient({
  interactions: {
    player: { intent: 'trade:request', label: 'Trade with', range: 3, quickUse: false },
  },
  overlay: { 'trade:ui': TradeLayer },
});
