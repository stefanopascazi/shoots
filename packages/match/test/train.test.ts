/**
 * The whole preference loop, end to end: duels → BT → ridge → profile JSON.
 *
 * The dataset here is synthetic but honest — photos live on a line in a 3-D
 * "embedding" and every duel agrees with that line — so a profile that cannot
 * rank them back is broken, not merely under-trained.
 */
import { describe, expect, test } from 'bun:test';
import { train } from '../src/ranking/train.js';
import { scoreOne } from '../src/ranking/ridge.js';
import type { Comparison, PhotoRow } from '../src/types.js';

/** Quality is the first dimension; the other two are noise the head must ignore. */
const photo = (id: number, quality: number): PhotoRow => ({
  id,
  path: `/photos/${id}.cr3`,
  preview_path: null,
  model: 'clip-test',
  embedding: Float32Array.from([quality, 0.05 * Math.sin(id), 0.05 * Math.cos(id)]),
  clip_score: null,
  aspects: null,
  created_at: '2026-08-02T00:00:00.000Z',
});

const PHOTOS: PhotoRow[] = Array.from({ length: 12 }, (_, i) => photo(i + 1, i));

/** Every pair, judged by the ground-truth quality. */
const ALL_DUELS: Comparison[] = (() => {
  const out: Comparison[] = [];
  for (let i = 0; i < PHOTOS.length; i++) {
    for (let j = i + 1; j < PHOTOS.length; j++) {
      out.push({ winner_id: PHOTOS[j]!.id, loser_id: PHOTOS[i]!.id });
    }
  }
  return out;
})();

const INPUT = {
  name: 'my-style',
  photos: PHOTOS,
  comparisons: ALL_DUELS,
  embeddingModel: 'clip-test',
  dim: 3,
};

describe('train', () => {
  test('emits the documented profile contract', () => {
    const profile = train(INPUT);

    expect(profile.name).toBe('my-style');
    expect(profile.type).toBe('linear-embedding');
    expect(profile.calibrated).toBe(true);
    expect(profile.embeddingModel).toBe('clip-test');
    expect(profile.dim).toBe(3);
    expect(profile.weights.length).toBe(3);
    expect(profile.aestheticStars.map((b) => b.stars)).toEqual([5, 4, 3, 2, 1]);
    expect(Number.isNaN(Date.parse(profile.trainedAt))).toBe(false);
  });

  test('carries the focus gate defaults, because a learned profile judges aesthetics only', () => {
    const profile = train(INPUT);
    expect(profile.focusReject).toBe(0.3);
    expect(profile.focusSoft).toBe(0.55);
    expect(profile.focusSoftCap).toBe(1);
  });

  test('learns a head that ranks the photos back in their true order', () => {
    const { weights, bias } = train(INPUT);
    const scored = PHOTOS.map((p) => ({ id: p.id, s: scoreOne(weights, bias, p.embedding) }));
    scored.sort((a, b) => a.s - b.s);
    expect(scored.map((r) => r.id)).toEqual(PHOTOS.map((p) => p.id));
  });

  test('generalizes to a photo that was never duelled', () => {
    const { weights, bias } = train(INPUT);
    const unseenGood = scoreOne(weights, bias, photo(99, 20).embedding);
    const unseenBad = scoreOne(weights, bias, photo(98, -10).embedding);
    expect(unseenGood).toBeGreaterThan(unseenBad);
  });

  test('reports the duel and photo counts it actually used', () => {
    const profile = train(INPUT);
    expect(profile.stats.duels).toBe(ALL_DUELS.length);
    expect(profile.stats.photos).toBe(PHOTOS.length);
    expect(profile.description).toBe(`Learned from ${ALL_DUELS.length} duels over ${PHOTOS.length} photos`);
  });

  test('scores the held-out duels well above chance on a learnable set', () => {
    const acc = train(INPUT).stats.heldOutPairAccuracy;
    expect(acc).not.toBeNull();
    expect(acc!).toBeGreaterThan(0.8);
  });

  test('is deterministic: the same input trains the same weights', () => {
    const a = train(INPUT);
    const b = train(INPUT);
    expect(b.weights).toEqual(a.weights);
    expect(b.bias).toBe(a.bias);
    expect(b.stats.heldOutPairAccuracy).toBe(a.stats.heldOutPairAccuracy);
  });

  test('declines to report an accuracy it cannot measure', () => {
    const small = train({ ...INPUT, photos: PHOTOS.slice(0, 3), comparisons: ALL_DUELS.slice(0, 3) });
    expect(small.stats.heldOutPairAccuracy).toBeNull();
  });

  test('ignores duels naming a photo the dataset does not contain', () => {
    const withGhost = train({
      ...INPUT,
      comparisons: [...ALL_DUELS, { winner_id: 9999, loser_id: 8888 }],
    });
    // The ghosts still count as duelled ids in the header stats, but they must
    // not reach the fit — a NaN weight here would poison every later score.
    expect(withGhost.weights.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(withGhost.bias)).toBe(true);
  });

  test('counts only the duelled photos, not the whole catalog', () => {
    const profile = train({
      ...INPUT,
      photos: [...PHOTOS, photo(500, 5.5)],
      comparisons: ALL_DUELS,
    });
    expect(profile.stats.photos).toBe(PHOTOS.length);
  });

  test('rounds the weights and bias so the profile JSON stays readable', () => {
    const profile = train(INPUT);
    for (const w of profile.weights) expect(Math.round(w * 1e6) / 1e6).toBe(w);
    expect(Math.round(profile.bias * 1e6) / 1e6).toBe(profile.bias);
  });

  test('honours a stronger ridge lambda by shrinking the head', () => {
    const light = train({ ...INPUT, ridgeLambda: 1e-6 });
    const heavy = train({ ...INPUT, ridgeLambda: 1e6 });
    const norm = (w: number[]): number => Math.sqrt(w.reduce((s, v) => s + v * v, 0));
    expect(norm(heavy.weights)).toBeLessThan(norm(light.weights));
  });
});
