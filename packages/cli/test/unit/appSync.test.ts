/**
 * Following Lightroom, last change wins: the pure rule, then the store applying
 * it, end to end with the outbox.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LibraryPhoto, LightroomState } from '@shoots/app';
import { photoLookup, parseLightroomState } from '../../src/app/server.js';
import { AppStore } from '../../src/app/store.js';
import { reconcile, satisfies } from '../../src/app/sync.js';

const lr = (rating: number, pick: -1 | 0 | 1 = 0, label: LightroomState['label'] = 'none'): LightroomState => ({ path: '/s/a.cr3', rating, pick, label });

describe('reconcile', () => {
  test('a first report imports what is set in Lightroom', () => {
    expect(reconcile(undefined, lr(4, 1, 'red'), undefined, undefined)).toEqual({ stars: 4, flag: 'pick', label: 'red' });
  });

  test('a first report never imports defaults, so shoots stays visible', () => {
    expect(reconcile(undefined, lr(0, 0, 'none'), undefined, undefined)).toEqual({});
  });

  test('a first report leaves a field the app already marked', () => {
    expect(reconcile(undefined, lr(4, -1), { stars: 2 }, undefined)).toEqual({ flag: 'reject' });
  });

  test('a later change in Lightroom wins, defaults included', () => {
    expect(reconcile(lr(4, 1, 'red'), lr(0, 1, 'red'), { stars: 4 }, undefined)).toEqual({ stars: 0 });
    expect(reconcile(lr(4, 1, 'red'), lr(4, 0, 'none'), { flag: 'pick', label: 'red' }, undefined)).toEqual({ flag: 'unflagged', label: 'none' });
  });

  test('no change, no patch', () => {
    expect(reconcile(lr(3, 1), lr(3, 1), undefined, undefined)).toEqual({});
  });

  test('an echo of what the app sent is not a change', () => {
    const sent = { path: '/s/a.cr3', rating: 5, pick: -1 as const, label: null };
    expect(reconcile(lr(2, 0), lr(5, -1), undefined, sent)).toEqual({});
  });

  test('a field the app did not send is still a change of yours', () => {
    const sent = { path: '/s/a.cr3', rating: null, pick: -1 as const, label: null };
    expect(reconcile(lr(2, 0), lr(3, -1), undefined, sent)).toEqual({ stars: 3 });
  });
});

describe('satisfies', () => {
  test('every non-null field must match', () => {
    expect(satisfies(lr(3, -1), { path: 'p', rating: 3, pick: null, label: null })).toBe(true);
    expect(satisfies(lr(3, -1), { path: 'p', rating: 3, pick: 1, label: null })).toBe(false);
  });
});

describe('parseLightroomState', () => {
  test('accepts a well-formed photo only', () => {
    expect(parseLightroomState({ path: 'p', rating: 3, pick: -1, label: 'red' })).toEqual({ path: 'p', rating: 3, pick: -1, label: 'red' });
    expect(parseLightroomState({ path: 'p', rating: 7, pick: 0, label: 'red' })).toBeUndefined();
    expect(parseLightroomState({ path: 'p', rating: 1, pick: 2, label: 'red' })).toBeUndefined();
    expect(parseLightroomState({ path: 'p', rating: 1, pick: 0, label: 'pink' })).toBeUndefined();
    expect(parseLightroomState(null)).toBeUndefined();
  });
});

describe('the store following Lightroom', () => {
  let store: AppStore;
  beforeEach(async () => {
    store = await AppStore.open(':memory:');
  });
  afterEach(() => store.close());

  const photo: LibraryPhoto = { path: '/s/a.cr3', name: 'a.cr3', kind: 'raw', size: 1, mtime: 1 };
  const statusOf = () => store.resultsFor([photo]);

  test('imports, then counts the photo as already in Lightroom', () => {
    expect(store.syncFromLightroom([lr(4, 1)])).toBe(1);
    expect(store.marksOf(photo.path)).toEqual({ stars: 4, flag: 'pick' });
    expect(statusOf().sent[photo.path]).toMatchObject({ state: 'applied', rating: 4, pick: 1 });
  });

  test('a report that changes nothing changes nothing', () => {
    store.syncFromLightroom([lr(4, 1)]);
    expect(store.syncFromLightroom([lr(4, 1)])).toBe(0);
  });

  test('the newest word wins: app, then Lightroom', () => {
    store.syncFromLightroom([lr(4, 1)]);
    store.setMarks(photo.path, { stars: 2 }); // you, in the app
    expect(store.marksOf(photo.path)).toEqual({ stars: 2, flag: 'pick' });
    store.syncFromLightroom([lr(5, 1)]); // then you, in Lightroom
    expect(store.marksOf(photo.path)).toEqual({ stars: 5, flag: 'pick' });
  });

  test('what the app sent comes back as an echo, not a change', () => {
    store.syncFromLightroom([lr(0)]);
    store.setMarks(photo.path, { flag: 'reject', label: 'red' });
    store.enqueue([{ path: photo.path, rating: null, pick: -1, label: 'red' }]);
    const [item] = store.pending();
    store.settle([item.id], []);
    store.syncFromLightroom([lr(0, -1, 'red')]);
    expect(store.marksOf(photo.path)).toEqual({ flag: 'reject', label: 'red' });
    expect(statusOf().sent[photo.path].state).toBe('applied');
  });

  test('a cull reject already in Lightroom needs no send', () => {
    const lookup = photoLookup([photo], false);
    store.saveResults('cull', [{ file: photo.path, score: 1, focusPeak: 1, verdict: 'blurry', rescued: false, aperture: null }], lookup);
    store.syncFromLightroom([lr(0, -1)]);
    // Imported as your flag too: in Lightroom it is a reject either way.
    expect(statusOf().sent[photo.path]).toMatchObject({ state: 'applied', pick: -1 });
  });

  test('resetting the send history makes the next report a first one', () => {
    store.syncFromLightroom([lr(3)]);
    store.reset([photo.path], ['marks', 'sent']);
    expect(store.marksOf(photo.path)).toBeUndefined();
    store.syncFromLightroom([lr(3)]);
    expect(store.marksOf(photo.path)).toEqual({ stars: 3 });
  });
});
