/**
 * SQLite access with no native build, no external dependency and no licence
 * question — the driver ships with whichever runtime is executing us:
 *
 *   - the standalone binary is Bun, which has `bun:sqlite` compiled in;
 *   - `node packages/cli/dist/cli.js` in development uses `node:sqlite`.
 *
 * Their surfaces coincide on everything used here (`exec`, `prepare` →
 * `run`/`get`/`all`, `close`), so the adapter is a constructor lookup rather
 * than a wrapper: no per-statement indirection on a hot loop.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** The slice of a SQLite driver shoots relies on. */
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

/** Which driver is in play — worth printing in a bug report. */
export function sqliteDriver(): 'bun:sqlite' | 'node:sqlite' {
  return isBun ? 'bun:sqlite' : 'node:sqlite';
}

/**
 * Open (creating if needed) a database file with WAL and foreign keys on.
 * `:memory:` opens a throwaway database.
 */
export async function openSqlite(path: string): Promise<Db> {
  ctor ??= loadDriver();
  const Database = await ctor;
  // SQLite creates the file but never the folder holding it.
  if (path !== ':memory:') await mkdir(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
