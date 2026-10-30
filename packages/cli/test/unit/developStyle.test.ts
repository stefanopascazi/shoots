import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  applyStyle,
  fitStyleBranch,
  fitStyleParam,
  resolveStylePath,
  validStyleName,
  type DevelopStyle,
} from '../../src/develop/style/style.js';
import type { Prediction } from '../../src/develop/predict.js';

const shoots = (entries: Record<string, number[]>): Map<string, number[]> => new Map(Object.entries(entries));

describe('fitStyleParam', () => {
  test('a departure every shoot agrees on is kept almost whole', () => {
    const p = fitStyleParam(shoots({ a: [20, 21], b: [19, 20], c: [21, 20], d: [20, 20] }));
    expect(p.mean).toBeCloseTo(20.1, 1);
    expect(p.shrink).toBeGreaterThan(0.95);
    expect(p.offset).toBeCloseTo(p.mean * p.shrink, 9);
  });

  test('shoots that disagree cancel out to almost nothing', () => {
    const p = fitStyleParam(shoots({ a: [30], b: [-25], c: [28], d: [-31] }));
    expect(Math.abs(p.offset)).toBeLessThan(1);
  });

  test('one shoot counts as one vote however many frames it has', () => {
    // Fifty frames at +10 against two shoots at −10: the mean is over shoots, not frames.
    const p = fitStyleParam(shoots({ big: Array(50).fill(10), b: [-10], c: [-10] }));
    expect(p.mean).toBeCloseTo(-10 / 3, 6);
  });

  test('a single consistent shoot survives, a single noisy one does not', () => {
    expect(fitStyleParam(shoots({ a: [15, 16, 14, 15] })).shrink).toBeGreaterThan(0.95);
    expect(fitStyleParam(shoots({ a: [40, -35, 30, -32] })).shrink).toBeLessThan(0.05);
  });

  test('no observations, no offset', () => {
    expect(fitStyleParam(new Map())).toEqual({ mean: 0, se: 0, shrink: 0, offset: 0 });
  });
});

describe('fitStyleBranch', () => {
  test('counts images and shoots and fits only observed params', () => {
    const b = fitStyleBranch(
      [
        { shoot: 's1', residuals: { Contrast2012: 10 } },
        { shoot: 's1', residuals: { Contrast2012: 12 } },
        { shoot: 's2', residuals: { Contrast2012: 11, Highlights2012: -5 } },
      ],
      'color',
    );
    expect(b.images).toBe(3);
    expect(b.shoots).toBe(2);
    expect(Object.keys(b.params).sort()).toEqual(['Contrast2012', 'Highlights2012']);
    expect(b.params.Contrast2012!.offset).toBeGreaterThan(9);
  });
});

describe('applyStyle', () => {
  const style: DevelopStyle = {
    type: 'develop-style',
    name: 'warm',
    base: { name: 'general', trainedAt: 't0' },
    trainedAt: 't1',
    branches: {
      color: {
        images: 10,
        shoots: 3,
        params: {
          Contrast2012: { mean: 10, se: 0, shrink: 1, offset: 10 },
          Highlights2012: { mean: -200, se: 0, shrink: 1, offset: -200 },
          Temperature: { mean: Math.log(1.1), se: 0, shrink: 1, offset: Math.log(1.1) },
        },
      },
    },
  };
  const prediction: Prediction = {
    file: 'a.cr3',
    treatment: 'color',
    develop: { Contrast2012: 5, Highlights2012: -40, Temperature: 5000, Shadows2012: 20 },
    render: {},
  };

  test('adds the departures on top of the general prediction', () => {
    const out = applyStyle(prediction, style).develop;
    expect(out.Contrast2012).toBe(15);
    // White balance departs as a ratio, not as Kelvin.
    expect(out.Temperature).toBeCloseTo(5500, 0);
    expect(out.Shadows2012).toBe(20);
  });

  test('clamps to the slider range', () => {
    expect(applyStyle(prediction, style).develop.Highlights2012).toBe(-100);
  });

  test('strength scales every departure; 0 is the general profile', () => {
    expect(applyStyle(prediction, style, 0.5).develop.Contrast2012).toBe(10);
    expect(applyStyle(prediction, style, 0)).toBe(prediction);
  });

  test('a treatment the style has no branch for passes through', () => {
    const bw = { ...prediction, treatment: 'bw' as const };
    expect(applyStyle(bw, style)).toBe(bw);
  });

  test('does not mutate the input', () => {
    applyStyle(prediction, style);
    expect(prediction.develop.Contrast2012).toBe(5);
  });
});

describe('style names and paths', () => {
  test('a name resolves under the styles directory, a path stays a path', () => {
    expect(path.basename(resolveStylePath('warm weddings'))).toBe('warm weddings.json');
    expect(path.dirname(resolveStylePath('warm'))).toMatch(/develop[\\/]styles$/);
    expect(resolveStylePath('some/dir/x.json')).toBe(path.resolve('some/dir/x.json'));
  });

  test('names must be safe file names', () => {
    expect(validStyleName('B&W')).toBe(false);
    expect(validStyleName('../evil')).toBe(false);
    expect(validStyleName('warm.json')).toBe(false);
    expect(validStyleName('Warm weddings_2026')).toBe(true);
  });
});
