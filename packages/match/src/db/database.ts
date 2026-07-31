/**
 * SQLite access with no native build, no external dependency and no licence
 * question — the driver ships with whichever runtime is executing us:
 *
 *   - the standalone binary is Bun, which has `bun:sqlite` compiled in;
 *   - `node packages/cli/dist/cli.js` in development uses `node:sqlite`.
 *
 * Their surfaces coincide on everything used here (`exec`, `prepare` →
 * `run`/`get`/`all`, `close`), so the adapter is a constructor lookup rather
 * than a wrapper: no per-statement indirection on a hot import loop.
 *
 * Embeddings are stored as raw little-endian Float32 BLOBs (2 KB for 512-d):
 * compact, exact, and trivially reconstituted into a Float32Array for the linear
 * algebra in `ranking/`. Both drivers hand BLOBs back as `Uint8Array`.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** The slice of a SQLite driver this package relies on. */
export interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

type DatabaseCtor = new (path: string) => Db;

/** `bun:sqlite` exports `Database`, `node:sqlite` exports `DatabaseSync`. */
interface SqliteModule {
  Database?: DatabaseCtor;
  DatabaseSync?: DatabaseCtor;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

let ctor: Promise<DatabaseCtor> | undefined;

async function loadDriver(): Promise<DatabaseCtor> {
  // Built from a variable on purpose. esbuild does not know `node:sqlite` — it
  // is newer than its builtin list — and rewrites the literal to a bare
  // `sqlite`, which resolves to nothing. A non-analyzable specifier is left
  // alone and resolved by the runtime, which is the one that actually knows.
  const specifier = isBun ? 'bun:sqlite' : 'node:sqlite';
  const mod = (await import(specifier)) as SqliteModule;
  const Database = mod.Database ?? mod.DatabaseSync;
  if (!Database) throw new Error(`${specifier} exposed no usable Database constructor`);
  return Database;
}

function driver(): Promise<DatabaseCtor> {
  ctor ??= loadDriver();
  return ctor;
}

/** Which driver is in play — worth printing in a bug report. */
export function sqliteDriver(): 'bun:sqlite' | 'node:sqlite' {
  return isBun ? 'bun:sqlite' : 'node:sqlite';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  preview_path  TEXT,
  model         TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  clip_score    REAL,
  aspects       TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comparisons (
  id         INTEGER PRIMARY KEY,
  winner_id  INTEGER NOT NULL REFERENCES photos(id),
  loser_id   INTEGER NOT NULL REFERENCES photos(id),
  session    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cmp_winner ON comparisons(winner_id);
CREATE INDEX IF NOT EXISTS idx_cmp_loser  ON comparisons(loser_id);
`;

export async function openDatabase(path: string): Promise<Db> {
  const Database = await driver();
  // SQLite creates the file but never the folder holding it, and on a fresh
  // machine ~/.shoots/match does not exist yet.
  if (path !== ':memory:') await mkdir(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for DBs created by an earlier version. */
function migrate(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(photos)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'preview_path')) {
    db.exec('ALTER TABLE photos ADD COLUMN preview_path TEXT');
  }
}

/** Pack a numeric embedding into a little-endian Float32 BLOB. */
export function encodeEmbedding(values: number[] | Float32Array): Uint8Array {
  const f = values instanceof Float32Array ? values : Float32Array.from(values);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** Unpack a Float32 BLOB into a fresh (aligned, copied) Float32Array. */
export function decodeEmbedding(blob: Uint8Array): Float32Array {
  const copy = Uint8Array.from(blob); // copy → 4-byte alignment and ownership
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
