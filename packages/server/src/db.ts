import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Entity } from './world.ts';

export interface EntityRow {
  id: number;
  kind: string;
  chunk: string;
  data: string;
  rev: number;
}

export interface TileRow {
  chunk: string;
  data: Uint8Array;
}

export interface PlayerRow {
  id: string;
  name: string;
  entityId: number | null;
  token: string;
}

/**
 * Components (and position) live inside the `data` JSON blob — there are no
 * per-component columns, and there will never be a migration. The moment
 * contributing requires a migration, contributions stop.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  chunk TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tiles (
  chunk TEXT PRIMARY KEY,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_id INTEGER,
  token TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  traits TEXT NOT NULL DEFAULT '{}',
  level INTEGER NOT NULL DEFAULT 1,
  state TEXT,
  created INTEGER NOT NULL,
  played INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS characters_account ON characters (account);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

/** Open (creating if needed) a database and make sure the schema exists. */
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Write-ahead logging with a relaxed sync. The default journal mode does a
  // full fsync per transaction, which made a bulk flush (a chunk's worth of
  // freshly decorated entities) cost hundreds of milliseconds — several
  // whole ticks of stutter. WAL + NORMAL risks only the last transaction on
  // a power cut, and the 50-tick flush interval already accepts ~5s of loss.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

/**
 * Upsert one entity. `rev` ticks up by one per save; the rest of the row is
 * the entity's live state serialized as JSON in the `data` blob.
 */
/**
 * Persist many entities and delete many rows in ONE transaction, with the
 * statements prepared once.
 *
 * The per-entity path below is fine for a stray write but catastrophic in
 * bulk: every call is its own implicit transaction (one fsync each) and
 * re-prepares two statements, so flushing a chunk's worth of decoration —
 * ~260 rows — took over 500ms, blocking the tick loop for half a second.
 * Batched it is a couple of milliseconds.
 */
export function saveEntities(
  db: DatabaseSync,
  entities: Iterable<Entity>,
  deleteIds: Iterable<number>,
): void {
  // `rev` increments in SQL, so there is no SELECT per row.
  const upsert = db.prepare(
    `INSERT INTO entities (id, kind, chunk, data, rev) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind, chunk = excluded.chunk, data = excluded.data, rev = rev + 1`,
  );
  const remove = db.prepare('DELETE FROM entities WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const e of entities) {
      upsert.run(
        e.id,
        e.kind,
        e.chunk,
        JSON.stringify({ x: e.x, y: e.y, world: e.world, components: e.components }),
      );
    }
    for (const id of deleteIds) remove.run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function saveEntity(db: DatabaseSync, entity: Entity): void {
  const prev = db.prepare('SELECT rev FROM entities WHERE id = ?').get(entity.id) as
    | { rev: number }
    | undefined;
  const rev = (prev?.rev ?? 0) + 1;
  const data = JSON.stringify({
    x: entity.x,
    y: entity.y,
    world: entity.world,
    components: entity.components,
  });
  db.prepare(
    'INSERT OR REPLACE INTO entities (id, kind, chunk, data, rev) VALUES (?, ?, ?, ?, ?)',
  ).run(entity.id, entity.kind, entity.chunk, data, rev);
}

/** Persist one chunk (its raw tile data, one byte per tile). */
export function saveChunk(db: DatabaseSync, chunkKey: string, data: Uint8Array): void {
  db.prepare('INSERT OR REPLACE INTO tiles (chunk, data) VALUES (?, ?)').run(chunkKey, data);
}

/** Every persisted chunk, keyed by its 'cx,cy' chunk key. */
export function loadChunks(db: DatabaseSync): Map<string, Uint8Array> {
  const rows = db
    .prepare('SELECT chunk, data FROM tiles ORDER BY chunk')
    .all() as unknown as TileRow[];
  const chunks = new Map<string, Uint8Array>();
  for (const row of rows) chunks.set(row.chunk, row.data);
  return chunks;
}

export function loadAll(db: DatabaseSync): { entities: EntityRow[] } {
  const entities = db
    .prepare('SELECT id, kind, chunk, data, rev FROM entities ORDER BY id')
    .all() as unknown as EntityRow[];
  return { entities };
}

export function savePlayer(db: DatabaseSync, player: PlayerRow): void {
  db.prepare('INSERT OR REPLACE INTO players (id, name, entity_id, token) VALUES (?, ?, ?, ?)').run(
    player.id,
    player.name,
    player.entityId,
    player.token,
  );
}

/**
 * kv access: without a value, returns the stored value; with a value, stores
 * it and returns the previous value. Undefined means "never set".
 */
export function getSet(db: DatabaseSync, k: string, v?: string): string | undefined {
  const prev = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  if (v !== undefined) {
    db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v);
  }
  return prev?.v;
}
