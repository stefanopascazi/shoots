/**
 * Star calibration.
 *
 * The promise is "5 stars = my top ~10%", whatever the raw score scale — so the
 * tests check that promise directly, and that the thresholds stay monotone.
 */
import { describe, expect, test } from 'bun:test';
import { calibrate } from '../src/ranking/calibrate.js';

const scoresOf = (n: number, f: (i: number) => number): number[] =>
  Array.from({ length: n }, (_, i) => f(i));

/** The star a normalized score earns, reading the table the way `rate` does. */
const starsFor = (bands: { min: number; stars: number }[], normalized: number): number => {
  for (const band of bands) if (normalized >= band.min) return band.stars;
  return 0;
};

describe('calibrate', () => {
  test('reports the mean and std of the raw scores', () => {
    const cal = calibrate([1, 2, 3, 4, 5]);
    expect(cal.scoreNormalization.mean).toBeCloseTo(3, 6);
    expect(cal.scoreNormalization.std).toBeCloseTo(Math.sqrt(2), 5);
  });

  test('emits five bands, descending in stars and in threshold', () => {
    const cal = calibrate(scoresOf(200, (i) => i));
    expect(cal.aestheticStars.map((b) => b.stars)).toEqual([5, 4, 3, 2, 1]);
    for (let i = 1; i < cal.aestheticStars.length; i++) {
      expect(cal.aestheticStars[i]!.min).toBeLessThanOrEqual(cal.aestheticStars[i - 1]!.min);
    }
  });

  test('every threshold sits inside the normalized [0,1] range', () => {
    const cal = calibrate(scoresOf(100, (i) => Math.sin(i) * 1000));
    for (const band of cal.aestheticStars) {
      expect(band.min).toBeGreaterThanOrEqual(0);
      expect(band.min).toBeLessThanOrEqual(1);
    }
  });

  test('is scale-invariant: multiplying every score changes no threshold', () => {
    const raw = scoresOf(150, (i) => Math.cos(i));
    const a = calibrate(raw);
    const b = calibrate(raw.map((s) => s * 1000 + 42));
    expect(b.aestheticStars).toEqual(a.aestheticStars);
  });

  test('awards 5 stars to roughly the top decile', () => {
    const raw = scoresOf(1000, (i) => i / 100);
    const cal = calibrate(raw);
    const { mean, std } = cal.scoreNormalization;
    const normalized = raw.map((s) => 1 / (1 + Math.exp(-(s - mean) / std)));
    const fives = normalized.filter((n) => starsFor(cal.aestheticStars, n) === 5).length;

    expect(fives / raw.length).toBeGreaterThan(0.05);
    expect(fives / raw.length).toBeLessThan(0.15);
  });

  test('never divides by zero when every score is identical', () => {
    const cal = calibrate([2, 2, 2, 2]);
    expect(cal.scoreNormalization.std).toBe(1); // the 0-variance fallback
    expect(cal.aestheticStars.every((b) => Number.isFinite(b.min))).toBe(true);
  });

  test('never divides by zero on an empty set', () => {
    const cal = calibrate([]);
    expect(Number.isFinite(cal.scoreNormalization.mean)).toBe(true);
    expect(cal.scoreNormalization.std).toBe(1);
    expect(cal.aestheticStars.every((b) => b.min === 0)).toBe(true);
  });

  test('rounds the emitted numbers so the profile JSON stays readable', () => {
    const cal = calibrate(scoresOf(50, (i) => i / 3));
    for (const band of cal.aestheticStars) {
      expect(Math.round(band.min * 1e4) / 1e4).toBe(band.min);
    }
    expect(Math.round(cal.scoreNormalization.mean * 1e6) / 1e6).toBe(cal.scoreNormalization.mean);
  });
});
