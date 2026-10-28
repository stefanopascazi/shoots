import { describe, expect, test } from 'bun:test';
import { applyMarksPatch, changeFor, sameChange, sanitizeMarksPatch, sendStatus, type SentChange } from '../src/outbox.js';
import { mergeResults, sendSummary, totals } from '../src/library/model.js';

describe('changeFor', () => {
  test('a cull reject sends pick -1, with the rating when there is one', () => {
    expect(changeFor('p', { verdict: 'blurry' }, 3, undefined)).toEqual({ path: 'p', rating: 3, pick: -1, label: null });
  });

  test('a sharp verdict leaves the pick in Lightroom alone', () => {
    expect(changeFor('p', { verdict: 'sharp' }, 4, undefined)).toEqual({ path: 'p', rating: 4, pick: null, label: null });
    expect(changeFor('p', { verdict: 'sharp' }, undefined, undefined)).toBeNull();
  });

  test('your flag wins over the verdict, both ways', () => {
    expect(changeFor('p', { verdict: 'blurry' }, undefined, { flag: 'pick' })?.pick).toBe(1);
    expect(changeFor('p', { verdict: 'blurry' }, undefined, { flag: 'unflagged' })?.pick).toBe(0);
    expect(changeFor('p', { verdict: 'sharp' }, undefined, { flag: 'reject' })?.pick).toBe(-1);
  });

  test('your stars win over the rating run; your label travels as is', () => {
    expect(changeFor('p', undefined, 2, { stars: 5, label: 'green' })).toEqual({ path: 'p', rating: 5, pick: null, label: 'green' });
    expect(changeFor('p', undefined, undefined, { label: 'none' })?.label).toBe('none');
  });

  test('nothing known, nothing to send — even without a cull', () => {
    expect(changeFor('p', undefined, undefined, undefined)).toBeNull();
    expect(changeFor('p', undefined, undefined, { flag: 'pick' })?.pick).toBe(1);
  });
});

describe('sendStatus', () => {
  const change = { path: 'p', rating: 3, pick: -1 as const, label: null };
  const sent = (state: SentChange['state'], rating = 3): SentChange => ({ ...change, rating, state });

  test('not sent, on its way, landed, not in the catalog', () => {
    expect(sendStatus(change, undefined)).toBe('unsent');
    expect(sendStatus(change, sent('pending'))).toBe('pending');
    expect(sendStatus(change, sent('applied'))).toBe('applied');
    expect(sendStatus(change, sent('missing'))).toBe('missing');
  });

  test('a different change than the one sent is "changed"', () => {
    expect(sendStatus(change, sent('applied', 5))).toBe('changed');
    expect(sendStatus({ ...change, label: 'red' }, sent('applied'))).toBe('changed');
    expect(sameChange(change, { ...change })).toBe(true);
  });

  test('nothing to send and nothing sent is "none"', () => {
    expect(sendStatus(null, undefined)).toBe('none');
  });
});

describe('marks patches', () => {
  test('only valid fields survive; null means hand it back', () => {
    expect(sanitizeMarksPatch({ flag: 'pick', stars: 6, label: 'pink', extra: 1 })).toEqual({ flag: 'pick' });
    expect(sanitizeMarksPatch({ flag: null, stars: 0, label: 'none' })).toEqual({ flag: null, stars: 0, label: 'none' });
    expect(sanitizeMarksPatch({ stars: 2.5 })).toEqual({});
    expect(sanitizeMarksPatch('nope')).toEqual({});
  });

  test('applying sets, clears, and empties to undefined', () => {
    const a = applyMarksPatch(undefined, { flag: 'pick', stars: 4 });
    expect(a).toEqual({ flag: 'pick', stars: 4 });
    expect(applyMarksPatch(a, { stars: null })).toEqual({ flag: 'pick' });
    expect(applyMarksPatch({ flag: 'pick' }, { flag: null })).toBeUndefined();
    expect(applyMarksPatch(a, {})).toEqual(a);
  });
});

describe('send totals', () => {
  const photo = (name: string) => ({ path: name, name, kind: 'raw' as const, size: 1, mtime: 0 });
  const blurry = (file: string) => ({ file, score: 1, focusPeak: 1, verdict: 'blurry' as const, rescued: false, aperture: null });
  const sent = {
    a: { path: 'a', rating: null, pick: -1 as const, label: null, state: 'applied' as const },
    b: { path: 'b', rating: null, pick: -1 as const, label: null, state: 'pending' as const },
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
