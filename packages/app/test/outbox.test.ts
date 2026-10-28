import { describe, expect, test } from 'bun:test';
import { changeFor, sameChange, sendStatus, type SentChange } from '../src/outbox.js';
import { mergeResults, sendSummary, totals } from '../src/library/model.js';

describe('changeFor', () => {
  test('a cull reject sends pick -1, with the rating when there is one', () => {
    expect(changeFor('p', { verdict: 'blurry' }, 3, undefined)).toEqual({ path: 'p', rating: 3, pick: -1 });
  });

  test('a sharp verdict leaves the pick alone', () => {
    expect(changeFor('p', { verdict: 'sharp' }, 4, undefined)).toEqual({ path: 'p', rating: 4, pick: null });
    expect(changeFor('p', { verdict: 'sharp' }, undefined, undefined)).toBeNull();
  });

  test('your Keep clears the flag, your Reject sets it', () => {
    expect(changeFor('p', { verdict: 'blurry' }, undefined, 'keep')).toEqual({ path: 'p', rating: null, pick: 0 });
    expect(changeFor('p', { verdict: 'sharp' }, undefined, 'reject')).toEqual({ path: 'p', rating: null, pick: -1 });
  });

  test('nothing known, nothing to send', () => {
    expect(changeFor('p', undefined, undefined, undefined)).toBeNull();
  });
});

describe('sendStatus', () => {
  const change = { path: 'p', rating: 3, pick: -1 as const };
  const sent = (state: SentChange['state'], rating = 3): SentChange => ({ ...change, rating, state });

  test('not sent, on its way, landed, not in the catalog', () => {
    expect(sendStatus(change, undefined)).toBe('unsent');
    expect(sendStatus(change, sent('pending'))).toBe('pending');
    expect(sendStatus(change, sent('applied'))).toBe('applied');
    expect(sendStatus(change, sent('missing'))).toBe('missing');
  });

  test('a different change than the one sent is "changed"', () => {
    expect(sendStatus(change, sent('applied', 5))).toBe('changed');
    expect(sameChange(change, { ...change })).toBe(true);
  });

  test('nothing to send and nothing sent is "none"', () => {
    expect(sendStatus(null, undefined)).toBe('none');
  });
});

describe('send totals', () => {
  const photo = (name: string) => ({ path: name, name, kind: 'raw' as const, size: 1, mtime: 0 });
  const blurry = (file: string) => ({ file, score: 1, focusPeak: 1, verdict: 'blurry' as const, rescued: false, aperture: null });
  const sent = {
    a: { path: 'a', rating: null, pick: -1 as const, state: 'applied' as const },
    b: { path: 'b', rating: null, pick: -1 as const, state: 'pending' as const },
  };
  const photos = mergeResults([photo('a'), photo('b'), photo('c'), photo('d')], [blurry('a'), blurry('b'), blurry('c')], undefined, false, {}, sent);

  test('each photo gets its state', () => {
    expect(photos.map((p) => p.send)).toEqual(['applied', 'pending', 'unsent', 'none']);
  });

  test('summary in words', () => {
    const t = totals(photos);
    expect([t.inLightroom, t.waiting, t.toSend, t.notInCatalog]).toEqual([1, 1, 1, 0]);
    expect(sendSummary(t)).toBe('1 in Lightroom · 1 waiting for Lightroom · 1 not sent yet');
    expect(sendSummary(totals([]))).toBeUndefined();
  });
});
