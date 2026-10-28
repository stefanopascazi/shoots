import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSqlite } from '@shoots/core';
import type { LibraryPhoto } from '@shoots/app';
import { AppStore, DEFAULT_SETTINGS, sanitizeSettings } from '../../src/app/store.js';
import { photoLookup } from '../../src/app/server.js';

let store: AppStore;
beforeEach(async () => {
  store = await AppStore.open(':memory:');
});
afterEach(() => store.close());

const photo = (name: string, size = 10, mtime = 1000): LibraryPhoto => ({ path: `/shoot/${name}`, name, kind: 'raw', size, mtime });
const cullItem = (file: string, verdict: 'sharp' | 'blurry') => ({ file, score: 1, focusPeak: 2, verdict, rescued: false, aperture: null });

describe('settings', () => {
  test('defaults until something is saved', () => {
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.reopenLastFolder).toBe(true);
  });

  test('a patch is merged and survives a reread', () => {
    store.updateSettings({ theme: 'light', filter: 'review' });
    expect(store.settings()).toMatchObject({ theme: 'light', filter: 'review', sort: 'name' });
  });

  test('unknown keys and bad values are dropped', () => {
    expect(sanitizeSettings({ theme: 'sepia', sort: 'rating', evil: 1, profile: '--x y', recursive: 'yes' })).toEqual({ sort: 'rating' });
    expect(sanitizeSettings(null)).toEqual({});
    expect(sanitizeSettings({ lastFolder: null, profile: null })).toEqual({ lastFolder: null, profile: null });
  });
});

describe('folders', () => {
  test('opening a folder makes it the one to reopen, most recent first', async () => {
    store.openedFolder('/a', false);
    await Bun.sleep(5);
    store.openedFolder('/b', true);
    await Bun.sleep(5);
    store.openedFolder('/a', false);
    expect(store.recentFolders()).toEqual(['/a', '/b']);
    expect(store.settings()).toMatchObject({ lastFolder: '/a', recursive: false });
  });
});

describe('results', () => {
  test('stored per photo and served while the file is unchanged', () => {
    const a = photo('a.cr3');
    const b = photo('b.cr3');
    const saved = store.saveResults('cull', [cullItem(a.path, 'sharp'), cullItem(b.path, 'blurry'), cullItem('/elsewhere.cr3', 'sharp')], photoLookup([a, b], false));
    expect(saved).toBe(2);
    store.saveResults('rate', [{ file: a.path, stars: 4, focus: 0.9, aesthetic: 0.6, keywords: [] }], photoLookup([a], false), 'my-eye');

    const r = store.resultsFor([a, b]);
    expect(r.cull.map((c) => c.verdict)).toEqual(['sharp', 'blurry']);
    expect(r.rate).toEqual([{ file: a.path, stars: 4, focus: 0.9, aesthetic: 0.6, keywords: [], profile: 'my-eye' }]);
  });

  test('a changed file loses its results', () => {
    const a = photo('a.cr3');
    store.saveResults('cull', [cullItem(a.path, 'sharp')], photoLookup([a], false));
    expect(store.resultsFor([{ ...a, mtime: 2000 }]).cull).toEqual([]);
    expect(store.resultsFor([{ ...a, size: 11 }]).cull).toEqual([]);
  });

  test('a re-run replaces the earlier result', () => {
    const a = photo('a.cr3');
    store.saveResults('cull', [cullItem(a.path, 'sharp')], photoLookup([a], false));
    store.saveResults('cull', [cullItem(a.path, 'blurry')], photoLookup([a], false));
    expect(store.resultsFor([a]).cull.map((c) => c.verdict)).toEqual(['blurry']);
  });

  test('results reported in another case are stored under the listed path on Windows', () => {
    const a: LibraryPhoto = { path: 'C:\\Shoot\\A.CR3', name: 'A.CR3', kind: 'raw', size: 1, mtime: 1 };
    store.saveResults('cull', [cullItem('c:\\shoot\\a.cr3', 'sharp')], photoLookup([a], true));
    expect(store.resultsFor([a]).cull[0].file).toBe('C:\\Shoot\\A.CR3');
  });
});

describe('marks', () => {
  test('set field by field, hand back, and drop the row when empty', () => {
    const a = photo('a.cr3');
    expect(store.setMarks(a.path, { flag: 'pick', stars: 4 })).toEqual({ flag: 'pick', stars: 4 });
    expect(store.setMarks(a.path, { label: 'green' })).toEqual({ flag: 'pick', stars: 4, label: 'green' });
    expect(store.setMarks(a.path, { stars: null })).toEqual({ flag: 'pick', label: 'green' });
    expect(store.resultsFor([a]).marks).toEqual({ [a.path]: { flag: 'pick', label: 'green' } });
    store.setMarks(a.path, { flag: null, label: null });
    expect(store.resultsFor([a]).marks).toEqual({});
  });

  test('zero stars is a mark of its own', () => {
    const a = photo('a.cr3');
    expect(store.setMarks(a.path, { stars: 0 })).toEqual({ stars: 0 });
  });

  test('marks outlive a change to the file', () => {
    const a = photo('a.cr3');
    store.setMarks(a.path, { flag: 'reject' });
    expect(store.resultsFor([{ ...a, mtime: 99 }]).marks).toEqual({ [a.path]: { flag: 'reject' } });
  });
});

describe('reset, in the app only', () => {
  const seed = () => {
    const a = photo('a.cr3');
    store.saveResults('cull', [cullItem(a.path, 'blurry')], photoLookup([a], false));
    store.saveResults('rate', [{ file: a.path, stars: 3, focus: 1, aesthetic: 1, keywords: [] }], photoLookup([a], false), 'p');
    store.setMarks(a.path, { flag: 'pick', label: 'red' });
    store.enqueue([{ path: a.path, rating: 3, pick: 1, label: 'red' }]);
    return a;
  };

  test('each part goes on its own', () => {
    const a = seed();
    store.reset([a.path], ['cull']);
    let r = store.resultsFor([a]);
    expect([r.cull.length, r.rate.length, Object.keys(r.marks).length, Object.keys(r.sent).length]).toEqual([0, 1, 1, 1]);
    store.reset([a.path], ['rate']);
    r = store.resultsFor([a]);
    expect([r.rate.length, Object.keys(r.marks).length]).toEqual([0, 1]);
    store.reset([a.path], ['marks']);
    r = store.resultsFor([a]);
    expect([Object.keys(r.marks).length, Object.keys(r.sent).length]).toEqual([0, 1]);
    store.reset([a.path], ['sent']);
    expect(store.resultsFor([a]).sent).toEqual({});
    expect(store.pendingCount()).toBe(0);
  });

  test('only the photos named', () => {
    const a = seed();
    const b = photo('b.cr3');
    store.setMarks(b.path, { stars: 2 });
    store.reset([a.path], ['marks']);
    expect(store.marksOf(b.path)).toEqual({ stars: 2 });
  });

  test('clearing the memory forgets everything', () => {
    const a = seed();
    store.updateSettings({ theme: 'light' });
    store.openedFolder('/shoot', false);
    store.clearAll();
    const r = store.resultsFor([a]);
    expect([r.cull, r.rate, r.marks, r.sent]).toEqual([[], [], {}, {}]);
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    expect(store.recentFolders()).toEqual([]);
  });
});

describe('migration from the first schema', () => {
  test('keep/reject decisions become flags and the outbox gains labels', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shoots-migrate-'));
    const file = path.join(dir, 'app.db');
    const v1 = await openSqlite(file);
    v1.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE decisions (path TEXT PRIMARY KEY, decision TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO decisions VALUES ('/shoot/a.cr3', 'keep', 't'), ('/shoot/b.cr3', 'reject', 't');
      CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, rating INTEGER, pick INTEGER,
        state TEXT NOT NULL, queued_at TEXT NOT NULL, settled_at TEXT);`);
    v1.close();

    const migrated = await AppStore.open(file);
    expect(migrated.marksOf('/shoot/a.cr3')).toEqual({ flag: 'pick' });
    expect(migrated.marksOf('/shoot/b.cr3')).toEqual({ flag: 'reject' });
    migrated.enqueue([{ path: '/shoot/a.cr3', rating: null, pick: 1, label: 'red' }]);
    expect(migrated.pending()[0].label).toBe('red');
    migrated.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  });
});

describe('outbox', () => {
  const change = (path: string, pick: -1 | 0 | null = -1, rating: number | null = null) => ({ path, rating, pick, label: null });

  test('queued changes wait until the plug-in settles them', () => {
    store.enqueue([change('/shoot/a.cr3'), change('/shoot/b.cr3', 0, 3)]);
    expect(store.pendingCount()).toBe(2);
    const [a, b] = store.pending();
    expect(b).toMatchObject({ path: '/shoot/b.cr3', rating: 3, pick: 0 });
    expect(store.settle([a.id], [b.id])).toBe(2);
    expect(store.pendingCount()).toBe(0);
    const sent = store.resultsFor([photo('a.cr3'), photo('b.cr3')]).sent;
    expect(sent['/shoot/a.cr3'].state).toBe('applied');
    expect(sent['/shoot/b.cr3'].state).toBe('missing');
  });

  test('a change queued again after collection is not settled by the old acknowledgement', () => {
    store.enqueue([change('/shoot/a.cr3', -1)]);
    const [collected] = store.pending();
    store.enqueue([change('/shoot/a.cr3', 0)]);
    expect(store.settle([collected.id], [])).toBe(0);
    expect(store.pending()).toMatchObject([{ path: '/shoot/a.cr3', pick: 0 }]);
  });

  test('sentUnder reads only the folder asked for', () => {
    store.enqueue([change('/shoot/a.cr3'), change('/other/x.cr3')]);
    expect(Object.keys(store.sentUnder('/shoot/'))).toEqual(['/shoot/a.cr3']);
  });
});
