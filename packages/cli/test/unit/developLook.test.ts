import { describe, expect, test } from 'bun:test';
import { solveTone } from '../../src/develop/look/solve.js';
import {
  BINS,
  displayValue,
  lookDistance,
  lookOf,
  lumaHistogram,
  NEUTRAL_TONE,
  shapeLog,
  toneFromDevelop,
  toneToDevelop,
  type LumaHistogram,
} from '../../src/develop/look/tone.js';

/** A frame whose log luma spreads evenly from `lo` to `hi` stops. */
function spread(lo: number, hi: number): LumaHistogram {
  const counts = new Float64Array(BINS);
  const a = Math.round((lo + 16) * 16);
  const b = Math.round((hi + 16) * 16);
  for (let i = a; i <= b; i++) counts[i] = 1 / (b - a + 1);
  return { counts, anchor: hi - 0.1 };
}

describe('tone', () => {
  test('neutral controls leave log luma unchanged', () => {
    for (const l of [-10, -5, -2, -0.5]) expect(shapeLog(l, -1, NEUTRAL_TONE)).toBeCloseTo(l, 9);
  });

  test('exposure is a pure shift in log', () => {
    expect(shapeLog(-4, -1, { ...NEUTRAL_TONE, exposure: 1 })).toBeCloseTo(-3, 9);
  });

  test('negative highlights pulls the bright end down, leaves deep shadows', () => {
    const t = { ...NEUTRAL_TONE, highlights: -1 };
    expect(shapeLog(-1, -1, t)).toBeLessThan(-1);
    expect(shapeLog(-9, -1, t)).toBeCloseTo(-9, 9);
  });

  test('positive shadows opens the deep tones, leaves the highlights', () => {
    // Camera Raw's sign: +Shadows lifts the dark end toward the pivot.
    const t = { ...NEUTRAL_TONE, shadows: 1 };
    expect(shapeLog(-9, -1, t)).toBeGreaterThan(-9);
    expect(shapeLog(-1, -1, t)).toBeCloseTo(-1, 9);
  });

  test('display value is monotone and bounded', () => {
    let prev = -1;
    for (let l = -12; l <= 1; l += 0.5) {
      const v = displayValue(l);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  test('develop round trip', () => {
    const d = { Exposure2012: 0.4, Contrast2012: -20, Highlights2012: -60, Shadows2012: 30, Whites2012: 10, Blacks2012: -5 };
    expect(toneToDevelop(toneFromDevelop(d))).toEqual(d);
  });

  test('lumaHistogram sums to one and finds the white', () => {
    const data = new Uint16Array(100 * 3);
    for (let i = 0; i < 100; i++) data.fill(i < 99 ? 4096 : 65535, i * 3, i * 3 + 3);
    const h = lumaHistogram({ data, width: 100, height: 1 });
    expect(h.counts.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    expect(h.anchor).toBeCloseTo(-4, 1);
  });

  test('look percentiles are ordered and brighten with exposure', () => {
    const h = spread(-10, -1);
    const base = lookOf(h, NEUTRAL_TONE);
    for (let i = 1; i < base.length; i++) expect(base[i]!).toBeGreaterThanOrEqual(base[i - 1]!);
    const up = lookOf(h, { ...NEUTRAL_TONE, exposure: 0.5 });
    expect(up[4]!).toBeGreaterThan(base[4]!);
    expect(lookDistance(base, base)).toBe(0);
  });
});

describe('solveTone', () => {
  test('recovers a look produced by known controls', () => {
    const h = spread(-11, -1.5);
    const truth = { ...NEUTRAL_TONE, exposure: 0.6, highlights: -0.5, shadows: 0.3 };
    const target = lookOf(h, truth);
    const got = solveTone(h, target, { stiffness: 0.01 });
    expect(lookDistance(lookOf(h, got), target)).toBeLessThan(1);
  });

  test('stays on the prior when the target is already met', () => {
    const h = spread(-10, -1);
    const prior = { ...NEUTRAL_TONE, contrast: 0.2 };
    const got = solveTone(h, lookOf(h, prior), { prior });
    expect(got).toEqual(prior);
  });

  test('weights leave unweighted percentiles free', () => {
    const h = spread(-11, -2);
    const target = lookOf(h, { ...NEUTRAL_TONE, exposure: 1 });
    // Ask only for the median; a wildly wrong value elsewhere must not matter.
    const partial = target.map((v, i) => (i === 4 ? v : 0));
    const weights = target.map((_, i) => (i === 4 ? 1 : 0));
    const got = solveTone(h, partial, { weights });
    expect(Math.abs(lookOf(h, got)[4]! - target[4]!) * 255).toBeLessThan(1.5);
    expect(got.exposure).toBeGreaterThan(0.5);
  });

  test('a darker frame needs more exposure for the same look', () => {
    const target = lookOf(spread(-10, -1), NEUTRAL_TONE);
    const dark = solveTone(spread(-11.5, -2.5), target, { stiffness: 0.01 });
    expect(dark.exposure).toBeGreaterThan(1);
  });
});
