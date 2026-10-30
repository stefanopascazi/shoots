import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { DEFAULT_THRESHOLDS, MIN_LOOKS, thresholdsFromLooks } from '../../src/develop/intents/calibrate.js';
import { loadIntentThresholds, sampleByShoot } from '../../src/develop/commands/intents.js';
import { applyIntents, resolveIntents } from '../../src/develop/intents/intents.js';
import { BINS, LOOK_PERCENTILES, lookOf, toneFromDevelop, type LumaHistogram } from '../../src/develop/look/tone.js';

/** A look with chosen p5, median and p99; the rest interpolated so it stays ordered. */
function look(p05: number, mid: number, p99: number): number[] {
  return LOOK_PERCENTILES.map((p) => (p <= 0.05 ? p05 * (p / 0.05) : p <= 0.5 ? p05 + ((mid - p05) * (p - 0.05)) / 0.45 : mid + ((p99 - mid) * (p - 0.5)) / 0.49));
}

describe('thresholdsFromLooks', () => {
  test('too few looks keep the defaults', () => {
    expect(thresholdsFromLooks(Array.from({ length: MIN_LOOKS - 1 }, () => look(0.05, 0.4, 0.9)))).toEqual(DEFAULT_THRESHOLDS);
  });

  test('reads the photographer’s own leanings', () => {
    // A low-key photographer: medians 0.20–0.30, contained highlights 0.80–0.90.
    const looks = Array.from({ length: 100 }, (_, i) => look(0.01 + (i % 10) * 0.004, 0.2 + (i % 10) * 0.01, 0.8 + (i % 10) * 0.01));
    const t = thresholdsFromLooks(looks);
    expect(t.midLow).toBeGreaterThan(0.2);
    expect(t.midHigh).toBeLessThan(0.3);
    expect(t.highlightCap).toBeLessThan(0.86);
    expect(t.shadowFloor).toBeGreaterThan(t.deepShadowCap);
  });

  test('never caps highlights at white, never lets the shadow bounds cross', () => {
    const flat = Array.from({ length: 50 }, () => look(0.05, 0.4, 1));
    const t = thresholdsFromLooks(flat);
    expect(t.highlightCap).toBeLessThanOrEqual(0.98);
    expect(t.shadowFloor).toBeGreaterThan(t.deepShadowCap);
    expect(t.midHigh).toBeGreaterThan(t.midLow);
  });
});

describe('sampleByShoot', () => {
  const records = [
    ...Array.from({ length: 100 }, (_, i) => ({ file: `/big/${i}.cr3` })),
    ...Array.from({ length: 5 }, (_, i) => ({ file: `/small/${i}.cr3` })),
  ];

  test('takes at most n, and every shoot gets a say', () => {
    const s = sampleByShoot(records, 20);
    expect(s.length).toBe(20);
    expect(s.filter((r) => r.file.startsWith('/small/')).length).toBeGreaterThanOrEqual(5);
  });

  test('returns everything when n exceeds the records', () => {
    expect(sampleByShoot(records.slice(0, 7), 50).length).toBe(7);
  });
});

describe('loadIntentThresholds', () => {
  test('defaults when nothing was calibrated, the file when it was', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'intents-'));
    expect(await loadIntentThresholds(path.join(dir, 'none.json'))).toEqual({ thresholds: DEFAULT_THRESHOLDS, calibrated: false });
    const file = path.join(dir, 'intents.json');
    writeFileSync(file, JSON.stringify({ type: 'develop-intents', at: 'x', frames: 30, shoots: 3, thresholds: { ...DEFAULT_THRESHOLDS, highlightCap: 0.8 } }));
    expect((await loadIntentThresholds(file)).thresholds.highlightCap).toBe(0.8);
  });
});

describe('applyIntents with calibrated thresholds', () => {
  test('a lower highlight cap pulls further', () => {
    const counts = new Float64Array(BINS);
    for (let i = Math.round((-9 + 16) * 16); i <= Math.round((-0.2 + 16) * 16); i++) counts[i] = 1;
    const s = counts.reduce((a, b) => a + b, 0);
    for (let i = 0; i < BINS; i++) counts[i] = counts[i]! / s;
    const h: LumaHistogram = { counts, anchor: -0.3 };
    const develop = { Exposure2012: 0.5, Contrast2012: 0, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0 };
    const intents = resolveIntents(['preserve-highlights']);
    const p99 = (d: Record<string, number>): number => lookOf(h, toneFromDevelop(d))[8]!;
    const standard = p99(applyIntents(develop, h, intents));
    const contained = p99(applyIntents(develop, h, intents, { ...DEFAULT_THRESHOLDS, highlightCap: 0.8 }));
    expect(contained).toBeLessThan(standard - 0.05);
  });
});
