import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSqlite, sqliteDriver } from '../src/db/sqlite.js';

const dir = mkdtempSync(path.join(tmpdir(), 'shoots-sqlite-'));
// Windows can hold the WAL files a moment after close; a leftover temp folder is harmless.
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
});

describe('openSqlite', () => {
  test('creates the missing folder and the file, with WAL and foreign keys on', async () => {
    const file = path.join(dir, 'nested', 'deeper', 'x.db');
    const db = await openSqlite(file);
    expect(existsSync(file)).toBe(true);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    db.close();
  });

  test('in memory, statements run and read back', async () => {
    const db = await openSqlite(':memory:');
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)');
    db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1);
    expect(db.prepare('SELECT v FROM t WHERE k = ?').get('a')).toEqual({ v: 1 });
    expect(db.prepare('SELECT * FROM t').all()).toHaveLength(1);
    db.close();
  });

  test('names the driver of the running runtime', () => {
    expect(sqliteDriver()).toBe('bun:sqlite');
  });
});
