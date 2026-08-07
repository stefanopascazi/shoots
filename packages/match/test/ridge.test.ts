/** Stage 2: the linear head that lets a profile score photos it never saw. */
import { describe, expect, test } from 'bun:test';
import { fitRidge, scoreOne } from '../src/ranking/ridge.js';

const rows = (data: number[][]): Float32Array[] => data.map((r) => Float32Array.from(r));

describe('fitRidge', () => {
  test('recovers an exact linear relationship when barely regularized', () => {
    // y = 2·x0 − 3·x1 + 1
    const X = rows([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [1, 2],
    ]);
    const y = X.map((r) => 2 * r[0]! - 3 * r[1]! + 1);
    const { weights, bias } = fitRidge(X, y, 1e-8);

    expect(Math.abs(weights[0]! - 2)).toBeLessThan(1e-4);
    expect(Math.abs(weights[1]! + 3)).toBeLessThan(1e-4);
    expect(Math.abs(bias - 1)).toBeLessThan(1e-4);
  });

  test('fits the intercept from the means rather than penalizing it', () => {
    const X = rows([[0], [1], [2], [3]]);
    const y = [100, 101, 102, 103];
    const { weights, bias } = fitRidge(X, y, 1e-8);
    expect(Math.abs(weights[0]! - 1)).toBeLessThan(1e-4);
    // A penalized intercept would drag the bias toward zero, not toward 100.
    expect(Math.abs(bias - 100)).toBeLessThan(1e-3);
  });

  test('shrinks the weights as lambda grows, leaving the bias at the target mean', () => {
    const X = rows([[0], [1], [2], [3]]);
    const y = [0, 2, 4, 6];
    const light = fitRidge(X, y, 1e-6);
    const heavy = fitRidge(X, y, 1e6);

    expect(Math.abs(heavy.weights[0]!)).toBeLessThan(Math.abs(light.weights[0]!));
    expect(Math.abs(heavy.weights[0]!)).toBeLessThan(0.01);
    expect(Math.abs(heavy.bias - 3)).toBeLessThan(1e-3);
  });

  test('predicts a constant target with zero slope', () => {
    const X = rows([[0, 1], [1, 5], [2, -3]]);
    const { weights, bias } = fitRidge(X, [7, 7, 7], 1e-6);
    expect(weights.every((w) => Math.abs(w) < 1e-6)).toBe(true);
    expect(Math.abs(bias - 7)).toBeLessThan(1e-6);
  });

  test('stays finite when a feature is constant across every row', () => {
    // A dead CLIP dimension makes the normal-equation matrix singular; the
    // solver's diagonal floor has to keep the whole fit usable anyway.
    const X = rows([
      [1, 0.5],
      [2, 0.5],
      [3, 0.5],
    ]);
    const { weights, bias } = fitRidge(X, [1, 2, 3], 1e-6);
    expect(weights.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(bias)).toBe(true);
  });

  test('handles a single training row without blowing up', () => {
    const { weights, bias } = fitRidge(rows([[1, 2]]), [5], 1);
    expect(weights.every(Number.isFinite)).toBe(true);
    expect(Math.abs(bias - 5)).toBeLessThan(1e-6);
  });

  test('refuses an empty training set with a named error', () => {
    expect(() => fitRidge([], [], 1)).toThrow(/ridge: empty training set/);
  });
});

describe('scoreOne', () => {
  test('is the affine score w·x + b', () => {
    expect(scoreOne([2, -1], 0.5, [3, 4])).toBeCloseTo(2.5, 10);
  });

  test('accepts the Float32Array embeddings the pipeline actually carries', () => {
    expect(scoreOne([1, 1], 0, Float32Array.from([0.25, 0.75]))).toBeCloseTo(1, 6);
  });

  test('agrees with the fit it came from', () => {
    const X = rows([[0], [1], [2]]);
    const { weights, bias } = fitRidge(X, [1, 3, 5], 1e-8);
    expect(scoreOne(weights, bias, [3])).toBeCloseTo(7, 3);
  });
});
