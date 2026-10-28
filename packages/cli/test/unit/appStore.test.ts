import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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

describe('decisions', () => {
  test('set, replace and clear', () => {
    const a = photo('a.cr3');
    store.setDecision(a.path, 'keep');
    expect(store.resultsFor([a]).decisions).toEqual({ [a.path]: 'keep' });
    store.setDecision(a.path, 'reject');
    expect(store.resultsFor([a]).decisions).toEqual({ [a.path]: 'reject' });
    store.setDecision(a.path, null);
    expect(store.resultsFor([a]).decisions).toEqual({});
  });

  test('a decision outlives a change to the file', () => {
    const a = photo('a.cr3');
    store.setDecision(a.path, 'keep');
    expect(store.resultsFor([{ ...a, mtime: 99 }]).decisions).toEqual({ [a.path]: 'keep' });
  });
});

describe('outbox', () => {
  const change = (path: string, pick: -1 | 0 | null = -1, rating: number | null = null) => ({ path, rating, pick });

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
