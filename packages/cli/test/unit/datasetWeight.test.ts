/**
 * How much a re-developed shoot counts when it comes back as training data.
 *
 * The scale is relative on purpose: "large compared to what you usually change",
 * never "large in slider units". An absolute scale would quietly stop weighting
 * anything as the model improved and every correction shrank.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_WEIGHT,
  DEFAULT_MIN_WEIGHT,
  paramSpread,
  weighByCorrection,
} from '../../src/develop/dataset/weight.js';
import { CURVE_KNOTS, curveParamKey } from '../../src/develop/develop/schema.js';
import type { DevelopExportResult } from '../../src/develop/types.js';
import type { Prediction } from '../../src/develop/predict.js';

const record = (file: string, develop: Record<string, number>): DevelopExportResult => ({
  file,
  embedding: [],
  features: [],
  develop,
  asShot: { tempAsShot: 5500, tintAsShot: 0, iso: 100, exposureComp: 0, camera: 'test' },
});

const prediction = (file: string, develop: Record<string, number>): Prediction =>
  ({ file, develop }) as unknown as Prediction;

describe('paramSpread', () => {
  test('measures the standard deviation of each parameter across the catalog', () => {
    const spread = paramSpread([
      record('a', { Contrast2012: 0 }),
      record('b', { Contrast2012: 10 }),
      record('c', { Contrast2012: 20 }),
    ]);
    // Population sd of {0,10,20}.
    expect(spread.get('Contrast2012')!).toBeCloseTo(Math.sqrt(200 / 3), 6);
  });

  // Dividing by an epsilon would turn a never-touched slider's rounding noise
  // into the loudest signal in the set.
  test('reports nothing for a parameter nobody ever moves', () => {
    const spread = paramSpread([
      record('a', { Contrast2012: 10 }),
      record('b', { Contrast2012: 10 }),
    ]);
    expect(spread.has('Contrast2012')).toBe(false);
  });

  test('needs at least two observations before it has a scale', () => {
    expect(paramSpread([record('a', { Contrast2012: 10 })]).has('Contrast2012')).toBe(false);
    expect(paramSpread([]).size).toBe(0);
  });

  test('ignores a non-finite stored value', () => {
    const spread = paramSpread([
      record('a', { Contrast2012: Number.NaN }),
      record('b', { Contrast2012: 10 }),
    ]);
    expect(spread.has('Contrast2012')).toBe(false);
  });

  test('measures the tone curve through its per-knot targets', () => {
    const straight = record('a', {});
    const bent = { ...record('b', {}), curve: [0, 0, 128, 200, 255, 255] };
    const spread = paramSpread([straight, bent]);
    expect(spread.has(curveParamKey(128))).toBe(true);
    // A knot at the ends is identical in both, so it has no scale.
    expect(spread.has(curveParamKey(CURVE_KNOTS[0]!))).toBe(false);
  });
});

describe('weighByCorrection', () => {
  const spread = new Map([['Contrast2012', 10]]);

  test('weights a typical correction at one', () => {
    const records = [record('a', { Contrast2012: 10 }), record('b', { Contrast2012: 20 })];
    const predictions = [prediction('a', { Contrast2012: 0 }), prediction('b', { Contrast2012: 10 })];
    const { records: weighted, medianZ } = weighByCorrection(records, predictions, spread);

    expect(medianZ).toBeCloseTo(1, 6); // both moved 10, i.e. one sd
    expect(weighted.map((w) => w.weight)).toEqual([1, 1]);
  });

  test('weights a frame you overhauled above one, and one you accepted below', () => {
    const records = [
      record('accepted', { Contrast2012: 1 }),
      record('typical', { Contrast2012: 10 }),
      record('overhauled', { Contrast2012: 40 }),
    ];
    const predictions = records.map((r) => prediction(r.file, { Contrast2012: 0 }));
    const { records: weighted } = weighByCorrection(records, predictions, spread);

    const by = new Map(weighted.map((w) => [w.file, w.weight]));
    expect(by.get('overhauled')!).toBeGreaterThan(1);
    expect(by.get('accepted')!).toBeLessThan(1);
    expect(by.get('typical')).toBe(1);
  });

  test('clamps into the configured band', () => {
    const records = [
      record('tiny', { Contrast2012: 0 }),
      record('typical', { Contrast2012: 10 }),
      record('huge', { Contrast2012: 10000 }),
    ];
    const predictions = records.map((r) => prediction(r.file, { Contrast2012: 0 }));
    const { records: weighted } = weighByCorrection(records, predictions, spread);

    for (const w of weighted) {
      expect(w.weight).toBeGreaterThanOrEqual(DEFAULT_MIN_WEIGHT);
      expect(w.weight).toBeLessThanOrEqual(DEFAULT_MAX_WEIGHT);
    }
    expect(weighted.find((w) => w.file === 'huge')!.weight).toBe(DEFAULT_MAX_WEIGHT);
    expect(weighted.find((w) => w.file === 'tiny')!.weight).toBe(DEFAULT_MIN_WEIGHT);
  });

  test('honours a caller-supplied band', () => {
    const records = [record('a', { Contrast2012: 0 }), record('b', { Contrast2012: 100 })];
    const predictions = records.map((r) => prediction(r.file, { Contrast2012: 50 }));
    const { records: weighted } = weighByCorrection(records, predictions, spread, {
      minWeight: 0.9,
      maxWeight: 1.1,
    });
    for (const w of weighted) {
      expect(w.weight).toBeGreaterThanOrEqual(0.9);
      expect(w.weight).toBeLessThanOrEqual(1.1);
    }
  });

  // The scale is relative, so a uniformly better model does not stop weighting.
  test('is scale-free: halving every correction changes no weight', () => {
    const build = (factor: number) => {
      const records = [1, 2, 5, 20].map((v, i) => record(`f${i}`, { Contrast2012: v * factor }));
      const predictions = records.map((r) => prediction(r.file, { Contrast2012: 0 }));
      return weighByCorrection(records, predictions, spread).records.map((w) => w.weight);
    };
    expect(build(0.5)).toEqual(build(1));
  });

  test('reports a file with no prediction instead of scoring it', () => {
    const result = weighByCorrection([record('a', {}), record('b', {})], [prediction('a', {})], spread);
    expect(result.unmatched).toEqual(['b']);
    expect(result.records.map((r) => r.file)).toEqual(['a']);
  });

  test('treats a slider absent from the edit as sitting at its neutral', () => {
    const records = [record('a', {})];
    const predictions = [prediction('a', { Contrast2012: 20 })];
    const [weighted] = weighByCorrection(records, predictions, spread).records;
    expect(weighted!.compared).toBe(1);
    expect(weighted!.z).toBeCloseTo(2, 6); // 20 points against an sd of 10
  });

  test('skips a predicted parameter the catalog has no scale for', () => {
    const records = [record('a', { Contrast2012: 10 })];
    const predictions = [prediction('a', { Contrast2012: 0, Dehaze: 50 })];
    const [weighted] = weighByCorrection(records, predictions, spread).records;
    expect(weighted!.compared).toBe(1);
  });

  test('leaves everything at one when nothing could be compared', () => {
    const records = [record('a', {}), record('b', {})];
    const predictions = records.map((r) => prediction(r.file, {}));
    const result = weighByCorrection(records, predictions, spread);
    expect(result.medianZ).toBe(0);
    expect(result.records.every((w) => w.weight === 1)).toBe(true);
  });

  test('handles an empty catalog', () => {
    expect(weighByCorrection([], [], spread)).toEqual({ records: [], medianZ: 0, unmatched: [] });
  });
});
