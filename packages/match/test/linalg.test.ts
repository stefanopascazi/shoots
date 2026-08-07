/** The Cholesky solver every ridge fit rests on. */
import { describe, expect, test } from 'bun:test';
import { dot, solveSPD } from '../src/ranking/linalg.js';

/** A·x, for checking a solution rather than trusting the solver twice. */
const matVec = (A: number[][], x: number[]): number[] => A.map((row) => dot(row, x));

const closeTo = (actual: number[], expected: number[], eps = 1e-9): void => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThan(eps));
};

describe('solveSPD', () => {
  test('solves the identity trivially', () => {
    closeTo(solveSPD([[1, 0], [0, 1]], [3, -4]), [3, -4]);
  });

  test('solves a known 2x2 system', () => {
    // [[4,1],[1,3]] · x = [1,2]  →  x = [1/11, 7/11]
    closeTo(solveSPD([[4, 1], [1, 3]], [1, 2]), [1 / 11, 7 / 11]);
  });

  test('reproduces b when the solution is substituted back', () => {
    const A = [
      [6, 2, 1],
      [2, 5, 2],
      [1, 2, 4],
    ];
    const b = [7, -3, 2];
    closeTo(matVec(A, solveSPD(A, b)), b, 1e-8);
  });

  test('scales linearly in b, as a linear solve must', () => {
    const A = [
      [3, 1],
      [1, 2],
    ];
    const x = solveSPD(A, [1, 1]);
    closeTo(solveSPD(A, [2, 2]), x.map((v) => v * 2));
  });

  test('leaves the caller matrix untouched', () => {
    const A = [
      [4, 1],
      [1, 3],
    ];
    const snapshot = JSON.stringify(A);
    solveSPD(A, [1, 2]);
    expect(JSON.stringify(A)).toBe(snapshot);
  });

  test('survives a singular matrix instead of dividing by zero', () => {
    // The 1e-12 floor on the diagonal is what keeps a degenerate feature — a
    // constant column in the embedding — from turning the whole fit into NaN.
    const x = solveSPD([[0, 0], [0, 0]], [1, 1]);
    expect(x.every(Number.isFinite)).toBe(true);
  });

  test('handles the 1x1 case', () => {
    closeTo(solveSPD([[2]], [6]), [3]);
  });
});

describe('dot', () => {
  test('multiplies elementwise and sums', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  test('is zero on empty input', () => {
    expect(dot([], [])).toBe(0);
  });

  test('accepts typed arrays on either side', () => {
    expect(dot(new Float32Array([1, 2]), new Float64Array([3, 4]))).toBe(11);
  });

  test('stops at the length of the first operand', () => {
    expect(dot([1, 2], [1, 2, 99])).toBe(5);
  });
});
