import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { CharacterSummary } from '@game/shared';

export const MAX_CHARACTERS = 8;

/** Where a character stood and what it carried when it last left the world. */
export interface CharacterState {
  x: number;
  y: number;
  world: string;
  components: Record<string, unknown>;
}

export interface CharacterRow {
  id: string;
  account: string;
  name: string;
  traits: Record<string, string>;
  level: number;
  /** Undefined until the character first enters the world. */
  state: CharacterState | undefined;
}

interface RawRow {
  id: string;
  account: string;
  name: string;
  traits: string;
  level: number;
  state: string | null;
  played: number;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRow(raw: RawRow): CharacterRow {
  return {
    id: raw.id,
    account: raw.account,
    name: raw.name,
    traits: parse(raw.traits, {}),
    level: raw.level,
    state: parse<CharacterState | undefined>(raw.state, undefined),
  };
}

export function listCharacters(db: DatabaseSync, account: string): CharacterSummary[] {
  const rows = db
    .prepare(
      'SELECT id, account, name, traits, level, state, played FROM characters WHERE account = ? ORDER BY played DESC, created ASC',
    )
    .all(account) as unknown as RawRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    level: r.level,
    traits: parse(r.traits, {}),
    lastPlayed: r.played,
  }));
}

export function getCharacter(db: DatabaseSync, id: string): CharacterRow | undefined {
  const raw = db
    .prepare('SELECT id, account, name, traits, level, state, played FROM characters WHERE id = ?')
    .get(id) as RawRow | undefined;
  return raw ? toRow(raw) : undefined;
}

/** Letters (any script), spaces, apostrophes and hyphens; 3 to 16 long. */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!/^[\p{L}][\p{L} '-]{1,14}[\p{L}]$/u.test(name)) return undefined;
  return name;
}

/** At most 8 traits, each a short id under a feature id. */
export function cleanTraits(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw).slice(0, 8)) {
    if (/^[a-z][a-z0-9_-]{0,31}$/.test(key) && typeof value === 'string' && /^[a-z0-9_-]{1,32}$/.test(value)) {
      out[key] = value;
    }
  }
  return out;
}

export type CreateResult = { ok: true } | { ok: false; error: string };

export function createCharacter(
  db: DatabaseSync,
  account: string,
  name: string,
  traits: Record<string, string>,
): CreateResult {
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM characters WHERE account = ?').get(account) as { n: number }
  ).n;
  if (count >= MAX_CHARACTERS) return { ok: false, error: `You can have at most ${MAX_CHARACTERS} characters.` };
  try {
    db.prepare(
      'INSERT INTO characters (id, account, name, name_key, traits, level, created) VALUES (?, ?, ?, ?, ?, 1, ?)',
    ).run(randomUUID(), account, name, name.toLowerCase(), JSON.stringify(traits), Date.now());
  } catch {
    return { ok: false, error: `The name “${name}” is taken.` };
  }
  return { ok: true };
}

export function deleteCharacter(db: DatabaseSync, account: string, id: string): void {
  db.prepare('DELETE FROM characters WHERE id = ? AND account = ?').run(id, account);
}

export function saveCharacter(db: DatabaseSync, id: string, level: number, state: CharacterState): void {
  db.prepare('UPDATE characters SET level = ?, state = ?, played = ? WHERE id = ?').run(
    level,
    JSON.stringify(state),
    Date.now(),
    id,
  );
}

export type Verify = (token: string) => Promise<string>;

/**
 * Access tokens are RS256 JWTs checked against the issuer's published keys,
 * so verifying one never calls the identity provider once its key set is
 * cached. Resolves to the account id; rejects on any invalid token.
 */
export function oidcVerifier(issuer: string): Verify {
  let keys: ReturnType<typeof createRemoteJWKSet> | undefined;
  async function keySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (keys) return keys;
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`discovery failed with ${res.status}`);
    const config = (await res.json()) as { jwks_uri?: unknown };
    if (typeof config.jwks_uri !== 'string') throw new Error('discovery has no jwks_uri');
    keys = createRemoteJWKSet(new URL(config.jwks_uri));
    return keys;
  }
  return async (token) => {
    const { payload } = await jwtVerify(token, await keySet(), { issuer });
    if (!payload.sub) throw new Error('token has no subject');
    return `oidc:${payload.sub}`;
  };
}
