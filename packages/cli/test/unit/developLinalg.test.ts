/**
 * The factor-once/solve-many linear algebra under the develop head.
 *
 * The whole point of splitting factor from solve is that P parameters share one
 * A: so the tests check that reusing a factor gives exactly what a fresh solve
 * would, and that the degenerate cases stay finite instead of yielding NaN.
 */
import { describe, expect, test } from 'bun:test';
import { choleskyFactor, dot, solveCholesky } from '../../src/develop/math/linalg.js';

const solve = (A: number[][], b: number[]): number[] => solveCholesky(choleskyFactor(A), b);
const matVec = (A: number[][], x: number[]): number[] => A.map((row) => dot(row, x));

const closeTo = (actual: number[], expected: number[], eps = 1e-9): void => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThan(eps));
};

describe('choleskyFactor', () => {
  test('produces a lower-triangular L with L·Lᵀ = A', () => {
    const A = [
      [4, 2, 1],
      [2, 5, 3],
      [1, 3, 6],
    ];
    const L = choleskyFactor(A);

    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) expect(L[i]![j]!).toBe(0);
    }
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += L[i]![k]! * L[j]![k]!;
        expect(Math.abs(s - A[i]![j]!)).toBeLessThan(1e-9);
      }
    }
  });

  test('takes the square root of the diagonal for a diagonal matrix', () => {
    const L = choleskyFactor([[9, 0], [0, 16]]);
    expect(L[0]![0]!).toBeCloseTo(3, 12);
    expect(L[1]![1]!).toBeCloseTo(4, 12);
  });

  test('floors a non-positive pivot instead of returning NaN', () => {
    // A dead feature column makes A singular; the fit still has to produce numbers.
    const L = choleskyFactor([[0, 0], [0, 0]]);
    expect(L.every((row) => Array.from(row).every(Number.isFinite))).toBe(true);
    expect(L[0]![0]!).toBeCloseTo(1e-6, 12);
  });

  test('does not modify the caller matrix', () => {
    const A = [[4, 1], [1, 3]];
    const snapshot = JSON.stringify(A);
    choleskyFactor(A);
    expect(JSON.stringify(A)).toBe(snapshot);
  });
});

describe('solveCholesky', () => {
  test('solves the identity trivially', () => {
    closeTo(solve([[1, 0], [0, 1]], [5, -2]), [5, -2]);
  });

  test('reproduces b when the solution is substituted back', () => {
    const A = [
      [6, 2, 1],
      [2, 5, 2],
      [1, 2, 4],
    ];
    const b = [7, -3, 2];
    closeTo(matVec(A, solve(A, b)), b, 1e-8);
  });

  test('one factor answers many right-hand sides — the reason it is split', () => {
    const A = [
      [5, 1, 0],
      [1, 4, 1],
      [0, 1, 3],
    ];
    const L = choleskyFactor(A);
    const rhs = [
      [1, 0, 0],
      [0, 1, 0],
      [2, -1, 4],
    ];
    for (const b of rhs) closeTo(solveCholesky(L, b), solve(A, b), 1e-12);
  });

  test('is linear in b', () => {
    const A = [[3, 1], [1, 2]];
    const L = choleskyFactor(A);
    const x = solveCholesky(L, [1, 1]);
    closeTo(solveCholesky(L, [3, 3]), x.map((v) => v * 3));
  });

  test('stays finite on a singular system', () => {
    expect(solve([[0, 0], [0, 0]], [1, 1]).every(Number.isFinite)).toBe(true);
  });

  test('handles the 1x1 case', () => {
    closeTo(solve([[4]], [8]), [2]);
  });
});

describe('dot', () => {
  test('multiplies elementwise and sums', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  test('is zero on empty input', () => {
    expect(dot([], [])).toBe(0);
  });

  test('accepts the typed arrays the feature rows actually use', () => {
    expect(dot(Float32Array.from([0.5, 0.5]), Float64Array.from([2, 4]))).toBeCloseTo(3, 6);
  });
});
