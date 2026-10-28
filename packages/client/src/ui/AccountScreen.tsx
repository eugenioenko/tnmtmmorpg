import { useEffect, useReducer, useState, type ReactNode } from 'react';
import type { CharacterSummary, CreationChoice } from '@game/shared';
import type { Account } from '../account.ts';
import { signInAgain, signOut } from '../auth.tsx';
import './account.css';

function useAccount(account: Account): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => account.onChange(force), [account]);
}

/** Everything between signing in and standing in the world. */
export function AccountScreen({
  account,
  choices,
}: {
  account: Account;
  choices: Record<string, CreationChoice>;
}) {
  useAccount(account);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!pending || account.phase !== 'select') return;
    if (account.error) {
      setPending(null);
      return;
    }
    const made = account.characters.find((c) => c.name.toLowerCase() === pending.toLowerCase());
    if (made) {
      setPending(null);
      setCreating(false);
      account.play(made.id);
    }
  });

  if (account.phase === 'playing') return null;

  if (account.phase === 'denied') {
    const replaced = account.denied?.reason === 'replaced';
    return (
      <Screen>
        <div className="account-error">{account.denied?.message}</div>
        <button type="button" className="btn" onClick={() => (replaced ? window.location.reload() : signInAgain())}>
          {replaced ? 'Play here instead' : 'Sign in again'}
        </button>
      </Screen>
    );
  }

  if (account.phase === 'connecting') {
    return (
      <Screen>
        <div className="muted">{account.playing ? 'Reconnecting…' : 'Connecting to the realm…'}</div>
      </Screen>
    );
  }

  const full = account.characters.length >= account.maxCharacters;
  if (creating || account.characters.length === 0) {
    return (
      <Screen wide>
        <CreateForm
          choices={choices}
          error={account.error}
          busy={pending !== null}
          onCancel={account.characters.length > 0 ? () => setCreating(false) : undefined}
          onCreate={(name, traits) => {
            setPending(name);
            account.create(name, traits);
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen wide>
      <div className="section-title">Choose your character</div>
      {account.error && <div className="account-error">{account.error}</div>}
      <div className="char-list">
        {account.characters.map((c) => (
          <CharacterCard key={c.id} character={c} choices={choices} account={account} />
        ))}
      </div>
      <div className="account-actions">
        <button type="button" className="btn" disabled={full} onClick={() => setCreating(true)}>
          {full ? `${account.maxCharacters} characters max` : 'New character'}
        </button>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={signOut}>
          Sign out
        </button>
      </div>
    </Screen>
  );
}

function Screen({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="account-screen">
      <div className={`account-card frame${wide ? ' wide' : ''}`}>
        <div className="account-title">tnmtmmorpg</div>
        {children}
      </div>
    </div>
  );
}

function CharacterCard({
  character,
  choices,
  account,
}: {
  character: CharacterSummary;
  choices: Record<string, CreationChoice>;
  account: Account;
}) {
  const [confirming, setConfirming] = useState(false);
  const icons = Object.entries(character.traits)
    .map(([feature, id]) => choices[feature]?.options.find((o) => o.id === id))
    .filter((o) => o !== undefined);
  return (
    <div className="char-card" onDoubleClick={() => account.play(character.id)}>
      <div className="char-icons">{icons.map((o) => o.icon).join('') || '🧑'}</div>
      <div className="char-info">
        <div className="char-name">{character.name}</div>
        <div className="muted">
          Level {character.level}
          {icons.length > 0 && ` · ${icons.map((o) => o.label).join(' · ')}`}
        </div>
      </div>
      {confirming ? (
        <>
          <button type="button" className="btn small danger" onClick={() => account.remove(character.id)}>
            Delete {character.name}
          </button>
          <button type="button" className="btn small" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn small" title="Delete" onClick={() => setConfirming(true)}>
            🗑
          </button>
          <button type="button" className="btn" onClick={() => account.play(character.id)}>
            Play
          </button>
        </>
      )}
    </div>
  );
}

function CreateForm({
  choices,
  error,
  busy,
  onCancel,
  onCreate,
}: {
  choices: Record<string, CreationChoice>;
  error: string | undefined;
  busy: boolean;
  onCancel?: () => void;
  onCreate: (name: string, traits: Record<string, string>) => void;
}) {
  const [name, setName] = useState('');
  const [traits, setTraits] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(choices)
        .filter(([, c]) => c.options.length > 0)
        .map(([feature, c]) => [feature, c.options[0].id]),
    ),
  );
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (name.trim().length >= 3) onCreate(name.trim(), traits);
  };
  return (
    <form onSubmit={submit}>
      <div className="section-title">Create a character</div>
      <label className="create-label" htmlFor="char-name">
        Name
      </label>
      <input
        id="char-name"
        className="create-name"
        autoFocus
        maxLength={16}
        value={name}
        placeholder="3 to 16 letters"
        onChange={(e) => setName(e.target.value)}
      />
      {Object.entries(choices).map(([feature, choice]) => {
        const picked = choice.options.find((o) => o.id === traits[feature]);
        return (
          <div key={feature}>
            <div className="create-label">{choice.label}</div>
            <div className="create-options">
              {choice.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`create-option${traits[feature] === o.id ? ' picked' : ''}`}
                  onClick={() => setTraits({ ...traits, [feature]: o.id })}
                >
                  <span className="create-icon">{o.icon}</span>
                  {o.label}
                </button>
              ))}
            </div>
            {picked?.blurb && <div className="hint">{picked.blurb}</div>}
          </div>
        );
      })}
      {error && <div className="account-error">{error}</div>}
      <div className="account-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Back
          </button>
        )}
        <span className="spacer" />
        <button type="submit" className="btn" disabled={busy || name.trim().length < 3}>
          Create and play
        </button>
      </div>
      <div className="account-foot">
        <button type="button" className="link" onClick={signOut}>
          Sign out
        </button>
      </div>
    </form>
  );
}
