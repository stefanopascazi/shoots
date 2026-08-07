/**
 * The multi-output ridge under the develop head.
 *
 * Two properties carry real weight beyond "the arithmetic is right": the normal
 * equations must be reusable across λ (a sweep depends on it), and λ must be
 * shrinkage *per sample* — a fixed λ that shrinks a 400-frame catalog four times
 * harder than a 1600-frame one is not a knob anybody can reason about, and that
 * is exactly how an earlier grid ended up annihilating every weight.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildNormalEquations,
  fitMultiRidge,
  predictStd,
  solveRidge,
} from '../../src/develop/train/regress.js';

/** y0 = 2·x0 − x1 + 3, y1 = −x0 + 0.5·x1 − 1. */
const X = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [2, 1],
  [1, 2],
  [2, 2],
  [3, 1],
];
const Y = X.map(([a, b]) => [2 * a! - b! + 3, -a! + 0.5 * b! - 1]);

const TINY = 1e-9;

describe('buildNormalEquations', () => {
  test('reports the shape of the problem it was handed', () => {
    const ne = buildNormalEquations(X, Y);
    expect(ne.d).toBe(2);
    expect(ne.p).toBe(2);
    expect(ne.xtx.length).toBe(2);
    expect(ne.rhs.length).toBe(2);
  });

  test('records the feature and target means', () => {
    const ne = buildNormalEquations(X, Y);
    for (let j = 0; j < 2; j++) {
      expect(ne.xbar[j]!).toBeCloseTo(X.reduce((s, r) => s + r[j]!, 0) / X.length, 9);
      expect(ne.ybar[j]!).toBeCloseTo(Y.reduce((s, r) => s + r[j]!, 0) / Y.length, 9);
    }
  });

  test('produces a symmetric cross-product matrix', () => {
    const { xtx, d } = buildNormalEquations(X, Y);
    for (let a = 0; a < d; a++) {
      for (let b = 0; b < d; b++) expect(xtx[a]![b]!).toBeCloseTo(xtx[b]![a]!, 9);
    }
  });

  test('sums the sample weights as the effective sample size', () => {
    expect(buildNormalEquations(X, Y).sw).toBe(X.length);
    expect(buildNormalEquations(X, Y, X.map(() => 0.5)).sw).toBeCloseTo(X.length / 2, 9);
  });

  test('a weight of two is the same as listing the sample twice', () => {
    const weighted = solveRidge(buildNormalEquations(X, Y, [2, ...X.slice(1).map(() => 1)]), TINY);
    const duplicated = solveRidge(buildNormalEquations([X[0]!, ...X], [Y[0]!, ...Y]), TINY);
    weighted.weights.forEach((row, k) =>
      row.forEach((w, j) => expect(w).toBeCloseTo(duplicated.weights[k]![j]!, 6)),
    );
  });

  test('refuses an empty training set', () => {
    expect(() => buildNormalEquations([], [])).toThrow(/ridge: empty training set/);
  });

  test('refuses weights that sum to nothing', () => {
    expect(() => buildNormalEquations(X, Y, X.map(() => 0))).toThrow(/weights sum to zero/);
  });
});

describe('solveRidge', () => {
  test('recovers an exact linear relationship at a negligible λ', () => {
    const { weights, bias } = solveRidge(buildNormalEquations(X, Y), TINY);

    expect(weights[0]![0]!).toBeCloseTo(2, 5);
    expect(weights[0]![1]!).toBeCloseTo(-1, 5);
    expect(bias[0]!).toBeCloseTo(3, 5);

    expect(weights[1]![0]!).toBeCloseTo(-1, 5);
    expect(weights[1]![1]!).toBeCloseTo(0.5, 5);
    expect(bias[1]!).toBeCloseTo(-1, 5);
  });

  test('shrinks toward the target mean as λ grows', () => {
    const ne = buildNormalEquations(X, Y);
    const heavy = solveRidge(ne, 1e6);
    expect(Math.abs(heavy.weights[0]![0]!)).toBeLessThan(1e-3);
    expect(heavy.bias[0]!).toBeCloseTo(ne.ybar[0]!, 4);
  });

  // The reason the normal equations are built once and the solve is separate.
  test('leaves the normal equations reusable across λ', () => {
    const ne = buildNormalEquations(X, Y);
    const first = solveRidge(ne, TINY);
    solveRidge(ne, 1e6);
    expect(solveRidge(ne, TINY)).toEqual(first);
  });

  test('λ means shrinkage per sample, so the same λ shrinks the same on a bigger catalog', () => {
    const doubled = [...X, ...X];
    const doubledY = [...Y, ...Y];
    const small = solveRidge(buildNormalEquations(X, Y), 0.5);
    const large = solveRidge(buildNormalEquations(doubled, doubledY), 0.5);
    small.weights.forEach((row, k) =>
      row.forEach((w, j) => expect(w).toBeCloseTo(large.weights[k]![j]!, 6)),
    );
  });

  test('emits one weight row and one bias per output parameter', () => {
    const { weights, bias } = fitMultiRidge(X, Y, 1);
    expect(weights.length).toBe(2);
    expect(bias.length).toBe(2);
    expect(weights.every((row) => row.length === 2)).toBe(true);
  });

  test('stays finite on a feature that never moves', () => {
    const constant = X.map(([a]) => [a!, 7]);
    const { weights, bias } = fitMultiRidge(constant, Y, 1e-6);
    expect(weights.flat().every(Number.isFinite)).toBe(true);
    expect(bias.every(Number.isFinite)).toBe(true);
  });
});

describe('predictStd', () => {
  test('is w·x + b, per parameter', () => {
    expect(predictStd([[1, 2], [0, -1]], [0.5, -0.5], [3, 4])).toEqual([11.5, -4.5]);
  });

  test('reproduces the training targets of an exact fit', () => {
    const { weights, bias } = fitMultiRidge(X, Y, TINY);
    X.forEach((row, i) => {
      const predicted = predictStd(weights, bias, row);
      predicted.forEach((v, k) => expect(v).toBeCloseTo(Y[i]![k]!, 5));
    });
  });

  test('returns one value per parameter', () => {
    expect(predictStd([[1, 1]], [0], [1, 1]).length).toBe(1);
  });
});
