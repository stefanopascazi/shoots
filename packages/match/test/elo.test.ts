/**
 * The duel picker.
 *
 * Elo here never leaves `serve` — it only chooses which pair to show. The
 * properties worth pinning are the seeding, the zero-sum update and the
 * active-learning bias toward under-compared photos.
 */
import { describe, expect, test } from 'bun:test';
import { applyOutcome, initElo, selectPair } from '../src/pairing/elo.js';

const photos = (n: number, clip: (i: number) => number | null = () => null) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, clip_score: clip(i) }));

describe('initElo', () => {
  test('seeds a neutral photo at the base rating', () => {
    const state = initElo([{ id: 1, clip_score: 0.5 }], new Map());
    expect(state.ratings.get(1)).toBe(1500);
  });

  test('spreads the seed ±200 around the base from the CLIP aesthetic', () => {
    const state = initElo(
      [
        { id: 1, clip_score: 1 },
        { id: 2, clip_score: 0 },
      ],
      new Map(),
    );
    expect(state.ratings.get(1)).toBe(1700);
    expect(state.ratings.get(2)).toBe(1300);
  });

  test('treats a missing CLIP score as neutral', () => {
    const state = initElo([{ id: 9, clip_score: null }], new Map());
    expect(state.ratings.get(9)).toBe(1500);
  });

  test('copies the counts instead of aliasing the caller map', () => {
    const counts = new Map([[1, 3]]);
    const state = initElo(photos(1), counts);
    state.counts.set(1, 99);
    expect(counts.get(1)).toBe(3);
    expect(state.counts.get(1)).toBe(99);
  });
});

describe('applyOutcome', () => {
  test('is zero-sum between the two photos', () => {
    const state = initElo(photos(2), new Map());
    const before = state.ratings.get(1)! + state.ratings.get(2)!;
    applyOutcome(state, 1, 2);
    expect(state.ratings.get(1)! + state.ratings.get(2)!).toBeCloseTo(before, 9);
  });

  test('moves the winner up and the loser down', () => {
    const state = initElo(photos(2), new Map());
    applyOutcome(state, 1, 2);
    expect(state.ratings.get(1)!).toBeGreaterThan(1500);
    expect(state.ratings.get(2)!).toBeLessThan(1500);
  });

  test('gives an even match the full half-K swing', () => {
    const state = initElo(photos(2), new Map());
    applyOutcome(state, 1, 2);
    expect(state.ratings.get(1)!).toBeCloseTo(1516, 6);
  });

  test('rewards an upset more than an expected win', () => {
    const expected = initElo([{ id: 1, clip_score: 1 }, { id: 2, clip_score: 0 }], new Map());
    applyOutcome(expected, 1, 2); // the favourite wins
    const favouriteGain = expected.ratings.get(1)! - 1700;

    const upset = initElo([{ id: 1, clip_score: 1 }, { id: 2, clip_score: 0 }], new Map());
    applyOutcome(upset, 2, 1); // the underdog wins
    const underdogGain = upset.ratings.get(2)! - 1300;

    expect(underdogGain).toBeGreaterThan(favouriteGain);
  });

  test('counts a duel for both photos', () => {
    const state = initElo(photos(2), new Map([[1, 4]]));
    applyOutcome(state, 1, 2);
    expect(state.counts.get(1)).toBe(5);
    expect(state.counts.get(2)).toBe(1);
  });

  test('treats an unknown id as a fresh base-rated photo', () => {
    const state = initElo(photos(1), new Map());
    applyOutcome(state, 1, 999);
    expect(state.ratings.get(999)).toBeCloseTo(1484, 6);
    expect(state.counts.get(999)).toBe(1);
  });
});

describe('selectPair', () => {
  test('returns null when there is nothing to compare', () => {
    expect(selectPair(initElo([], new Map()))).toBeNull();
    expect(selectPair(initElo(photos(1), new Map()))).toBeNull();
  });

  test('returns the only possible pair when exactly two photos exist', () => {
    const pair = selectPair(initElo(photos(2), new Map()))!;
    expect(pair.slice().sort()).toEqual([1, 2]);
  });

  test('never pairs a photo with itself, over many draws', () => {
    const state = initElo(photos(20, (i) => i / 20), new Map());
    for (let i = 0; i < 200; i++) {
      const [a, b] = selectPair(state)!;
      expect(a).not.toBe(b);
      expect(state.ratings.has(a)).toBe(true);
      expect(state.ratings.has(b)).toBe(true);
    }
  });

  test('draws the first photo from the least-compared quartile', () => {
    // 8 photos: ids 1..2 unseen, the rest heavily duelled. The pool is the
    // bottom quarter — floor(8/4) = 2 — so A must be one of the unseen pair.
    const counts = new Map<number, number>();
    for (let id = 1; id <= 8; id++) counts.set(id, id <= 2 ? 0 : 50 + id);
    const state = initElo(photos(8), counts);

    for (let i = 0; i < 100; i++) {
      const [a] = selectPair(state)!;
      expect(a === 1 || a === 2).toBe(true);
    }
  });

  test('prefers an opponent close in rating over a blow-out', () => {
    // Two rating clusters 1000 apart, each internally tight. Whichever cluster
    // the first photo is drawn from, an informative opponent is in that cluster.
    const state = initElo([], new Map());
    for (let id = 1; id <= 40; id++) {
      state.ratings.set(id, id <= 20 ? 1500 + id * 0.1 : 2500 + id * 0.1);
      state.counts.set(id, 10);
    }

    for (let i = 0; i < 100; i++) {
      const [a, b] = selectPair(state)!;
      const delta = Math.abs(state.ratings.get(a)! - state.ratings.get(b)!);
      expect(delta).toBeLessThan(100);
    }
  });
});
