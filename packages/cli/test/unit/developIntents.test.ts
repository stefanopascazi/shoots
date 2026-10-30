import { describe, expect, test } from 'bun:test';
import { applyIntents, INTENT_IDS, resolveIntents } from '../../src/develop/intents/intents.js';
import { constrained, meetConstraints, violation } from '../../src/develop/look/solve.js';
import { BINS, LOOK_PERCENTILES, lookOf, NEUTRAL_TONE, toneFromDevelop, type LumaHistogram } from '../../src/develop/look/tone.js';

/** A frame whose log luma spreads evenly from `lo` to `hi` stops. */
function spread(lo: number, hi: number): LumaHistogram {
  const counts = new Float64Array(BINS);
  const a = Math.round((lo + 16) * 16);
  const b = Math.round((hi + 16) * 16);
  for (let i = a; i <= b; i++) counts[i] = 1 / (b - a + 1);
  return { counts, anchor: hi - 0.1 };
}
const at = (p: number): number => LOOK_PERCENTILES.indexOf(p as (typeof LOOK_PERCENTILES)[number]);
const look = (h: LumaHistogram, develop: Record<string, number>): number[] => lookOf(h, toneFromDevelop(develop));

describe('resolveIntents', () => {
  test('normalises and de-duplicates', () => {
    expect(resolveIntents([' Preserve-Highlights', 'preserve-highlights']).map((i) => i.id)).toEqual(['preserve-highlights']);
  });

  test('rejects unknown ids, naming the available ones', () => {
    expect(() => resolveIntents(['brighter'])).toThrow(/unknown intent.*brighter.*available/);
  });

  test('rejects pairs that ask for opposite things', () => {
    expect(() => resolveIntents(['open-shadows', 'keep-shadows-deep'])).toThrow(/opposite/);
    expect(() => resolveIntents(['soft-contrast', 'punchy-contrast'])).toThrow(/opposite/);
  });

  test('every intent has a label', () => {
    for (const i of resolveIntents(INTENT_IDS.filter((id) => id !== 'keep-shadows-deep' && id !== 'punchy-contrast'))) {
      expect(i.label.length).toBeGreaterThan(0);
    }
  });
});

describe('constraints', () => {
  test('violation is zero inside the bounds and grows outside', () => {
    const l = lookOf(spread(-10, -1), NEUTRAL_TONE);
    const median = l[at(0.5)]!;
    expect(violation(l, [{ at: at(0.5), min: median - 0.01, max: median + 0.01 }])).toBe(0);
    expect(violation(l, [{ at: at(0.5), max: median - 0.1 }])).toBeGreaterThan(0);
    expect(constrained(l, 'spread')).toBeCloseTo(l[at(0.9)]! - l[at(0.1)]!, 12);
  });

  test('a prior that already meets every bound comes back untouched', () => {
    const h = spread(-10, -1);
    const prior = { ...NEUTRAL_TONE, contrast: 0.1 };
    expect(meetConstraints(h, [{ at: at(0.5), min: 0, max: 1 }], prior)).toBe(prior);
  });
});

describe('applyIntents', () => {
  const develop = { Exposure2012: 0.5, Contrast2012: 10, Highlights2012: 0, Shadows2012: 0, Whites2012: 20, Blacks2012: 0, Saturation: 7 };

  test('preserve highlights pulls a blown top end under the cap, and touches only tone', () => {
    const h = spread(-9, -0.2);
    expect(look(h, develop)[at(0.99)]!).toBeGreaterThan(0.95);
    const out = applyIntents(develop, h, resolveIntents(['preserve-highlights']));
    expect(look(h, out)[at(0.99)]!).toBeLessThanOrEqual(0.935);
    expect(out.Saturation).toBe(7);
  });

  test('an intent the prediction already meets changes nothing', () => {
    const h = spread(-12, -4);
    expect(applyIntents(develop, h, resolveIntents(['preserve-highlights']))).toBe(develop);
  });

  test('open shadows lifts the 5th percentile with Shadows and Blacks only', () => {
    const h = spread(-10, -2);
    const out = applyIntents(develop, h, resolveIntents(['open-shadows']));
    // Deep in a 10-stop frame the floor is past what the two sliders can reach:
    // they go as far as they can, and nothing else is recruited to fake it.
    expect(look(h, out)[at(0.05)]!).toBeGreaterThan(look(h, develop)[at(0.05)]! + 0.04);
    expect(out.Shadows2012).toBeGreaterThan(develop.Shadows2012);
    expect(out.Exposure2012).toBe(develop.Exposure2012);
    expect(out.Contrast2012).toBe(develop.Contrast2012);
  });

  test('soft contrast narrows the spread by about the step (10 %)', () => {
    const h = spread(-10, -1);
    const before = constrained(look(h, develop), 'spread');
    const after = constrained(look(h, applyIntents(develop, h, resolveIntents(['soft-contrast']))), 'spread');
    expect(after).toBeLessThanOrEqual(before * 0.91);
    expect(after).toBeGreaterThan(before * 0.8);
  });

  test('expose correctly brings a dark frame into the midtone band', () => {
    const h = spread(-7.5, -1.5);
    const dark = { ...develop, Exposure2012: 0 };
    expect(look(h, dark)[at(0.5)]!).toBeLessThan(0.38);
    const out = applyIntents(dark, h, resolveIntents(['expose-correctly']));
    expect(look(h, out)[at(0.5)]!).toBeGreaterThanOrEqual(0.375);
  });

  test('no intents, no work', () => {
    expect(applyIntents(develop, spread(-9, -0.2), [])).toBe(develop);
  });
});

describe('applyIntents keeps what it did not move', () => {
  test('untouched sliders keep their exact predicted value', () => {
    const h = spread(-10, -1);
    const develop = { Exposure2012: 0.3333, Contrast2012: 2.37, Highlights2012: -10.4, Shadows2012: 5.5, Whites2012: 3.3, Blacks2012: 1.1 };
    const out = applyIntents(develop, h, resolveIntents(['soft-contrast']));
    expect(out.Contrast2012).not.toBe(develop.Contrast2012);
    expect(out.Exposure2012).toBe(0.3333);
    expect(out.Highlights2012).toBe(-10.4);
    expect(out.Shadows2012).toBe(5.5);
  });
});

describe('intent strength', () => {
  const h = spread(-10, -1);
  const develop = { Exposure2012: 0.3, Contrast2012: 10, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0 };
  const intents = resolveIntents(['soft-contrast']);

  test('half strength moves about half as far', () => {
    const full = applyIntents(develop, h, intents).Contrast2012! - develop.Contrast2012;
    const half = applyIntents(develop, h, intents, undefined, 0.5).Contrast2012! - develop.Contrast2012;
    expect(full).toBeLessThan(-5);
    expect(Math.abs(half - full / 2)).toBeLessThanOrEqual(1);
  });

  test('zero strength is the prediction', () => {
    expect(applyIntents(develop, h, intents, undefined, 0)).toBe(develop);
  });
});
