/**
 * The embedding projection.
 *
 * Determinism is not a nicety here: two runs on one catalog must produce the
 * same profile, and the power iteration is seeded precisely so they do.
 */
import { describe, expect, test } from 'bun:test';
import { applyPca, fitPca } from '../../src/develop/train/pca.js';

/** Points along a known direction, plus a small offset off it. */
const alongAxis = (n: number, direction: number[], mean: number[]): number[][] =>
  Array.from({ length: n }, (_, i) => {
    const t = i - (n - 1) / 2;
    return direction.map((d, j) => mean[j]! + d * t);
  });

const absDot = (a: number[], b: number[]): number =>
  Math.abs(a.reduce((s, v, i) => s + v * b[i]!, 0));

const norm = (v: number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe('fitPca', () => {
  test('records the per-dimension mean', () => {
    const model = fitPca([[0, 10], [2, 20], [4, 30]], 1);
    expect(model.mean).toEqual([2, 20]);
  });

  test('finds the direction the data actually varies along', () => {
    const model = fitPca(alongAxis(9, [1, 0, 0], [0, 5, 5]), 1);
    expect(absDot(model.components[0]!, [1, 0, 0])).toBeCloseTo(1, 6);
  });

  test('returns unit-length components', () => {
    const model = fitPca(alongAxis(20, [1, 2, 3], [0, 0, 0]), 2);
    for (const c of model.components) expect(norm(c)).toBeCloseTo(1, 8);
  });

  test('returns mutually orthogonal components', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [
      Math.sin(i) * 10,
      Math.cos(i) * 3,
      Math.sin(i * 2) * 0.5,
    ]);
    const model = fitPca(rows, 3);
    for (let a = 0; a < model.components.length; a++) {
      for (let b = a + 1; b < model.components.length; b++) {
        expect(absDot(model.components[a]!, model.components[b]!)).toBeLessThan(1e-6);
      }
    }
  });

  test('orders the components by how much variance they explain', () => {
    const rows = Array.from({ length: 60 }, (_, i) => [Math.sin(i) * 100, Math.cos(i) * 1, 0]);
    const model = fitPca(rows, 2);
    const spread = (c: number[]): number => {
      const projected = rows.map((r) => r.reduce((s, v, j) => s + (v - model.mean[j]!) * c[j]!, 0));
      const m = projected.reduce((a, b) => a + b, 0) / projected.length;
      return projected.reduce((s, v) => s + (v - m) ** 2, 0);
    };
    expect(spread(model.components[0]!)).toBeGreaterThan(spread(model.components[1]!));
  });

  test('is deterministic — the same catalog trains the same projection', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [i, i * i, Math.sin(i)]);
    expect(fitPca(rows, 3)).toEqual(fitPca(rows, 3));
  });

  test('never asks for more components than the data can support', () => {
    expect(fitPca([[1, 2, 3, 4]], 10).components.length).toBeLessThanOrEqual(1);
    expect(fitPca(alongAxis(9, [1, 1], [0, 0]), 50).components.length).toBeLessThanOrEqual(2);
  });

  test('yields no components when asked for none', () => {
    expect(fitPca([[1, 2]], 0).components).toEqual([]);
    expect(fitPca([[1, 2]], -3).components).toEqual([]);
  });

  test('stays finite on data with no variance at all', () => {
    const model = fitPca([[1, 1], [1, 1], [1, 1]], 2);
    expect(model.mean).toEqual([1, 1]);
    expect(model.components.every((c) => c.every(Number.isFinite))).toBe(true);
  });

  test('refuses an empty training set with a named error', () => {
    expect(() => fitPca([], 2)).toThrow(/pca: empty training set/);
  });
});

describe('applyPca', () => {
  test('projects onto every component, in order', () => {
    const model = { mean: [0, 0], components: [[1, 0], [0, 1]] };
    expect(applyPca([3, 4], model)).toEqual([3, 4]);
  });

  test('subtracts the mean before projecting', () => {
    const model = { mean: [1, 1], components: [[1, 0]] };
    expect(applyPca([3, 0], model)).toEqual([2]);
  });

  test('maps the mean itself to the origin', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [i, Math.sin(i)]);
    const model = fitPca(rows, 2);
    for (const v of applyPca(model.mean, model)) expect(Math.abs(v)).toBeLessThan(1e-9);
  });

  test('produces one number per component', () => {
    const model = fitPca(alongAxis(12, [1, 2, 3], [0, 0, 0]), 2);
    expect(applyPca([1, 1, 1], model).length).toBe(model.components.length);
  });

  test('is empty when the model kept no components', () => {
    expect(applyPca([1, 2, 3], { mean: [0, 0, 0], components: [] })).toEqual([]);
  });
});
