/**
 * The measurement machinery the develop gate rests on.
 *
 * Folds are drawn over whole shoots on purpose: near-duplicate frames from one
 * session sitting on both sides of a split measure "finish a shoot already under
 * way", not "predict a shoot you have never seen", and the second is the question
 * the gate asks. That grouping, the degenerate-target flag and the weighted
 * headline are what keep a number from being reported as skill when it is not.
 */
import { describe, expect, test } from 'bun:test';
import {
  assignFolds,
  clampResponse,
  columnStats,
  degenerateTargets,
  EPS,
  GROUP_BY_MODES,
  LAMBDA_GRID,
  MAX_RESPONSE,
  shuffled,
  standardize,
  weightedSkill,
  type EvalRow,
  type ParamStats,
} from '../../src/develop/train/evaluate.js';
import { DEVELOP_PARAMS, type DevelopParam } from '../../src/develop/develop/schema.js';

const row = (group: string, deltas: number[] = [0]): EvalRow =>
  ({ x: [1], deltas, abs: deltas, group }) as EvalRow;

const param = (key: string): DevelopParam => DEVELOP_PARAMS.find((p) => p.key === key)!;

const stat = (skill: number, baselineMae = 1): ParamStats => ({ skill, baselineMae }) as ParamStats;

describe('the published constants', () => {
  test('the λ grid is ascending and bottoms out where it is safe to', () => {
    expect(LAMBDA_GRID[0]).toBe(0.1);
    for (let i = 1; i < LAMBDA_GRID.length; i++) {
      expect(LAMBDA_GRID[i]!).toBeGreaterThan(LAMBDA_GRID[i - 1]!);
    }
  });

  test('names both fold policies', () => {
    expect(GROUP_BY_MODES).toEqual(['folder', 'none']);
  });
});

describe('clampResponse', () => {
  test('leaves an ordinary slope alone', () => {
    expect(clampResponse(1)).toBe(1);
    expect(clampResponse(2.5)).toBe(2.5);
  });

  test('leaves a slope under one alone — that is genuine over-reach being undone', () => {
    expect(clampResponse(0.4)).toBe(0.4);
  });

  test('caps an enormous slope produced out of a prediction that barely moves', () => {
    expect(clampResponse(20)).toBe(MAX_RESPONSE);
  });

  test('honours a caller-supplied ceiling', () => {
    expect(clampResponse(20, 5)).toBe(5);
  });

  test('never returns a negative slope — that would invert the prediction', () => {
    expect(clampResponse(-4)).toBe(0);
  });

  test('falls back to leaving the output alone when the slope is not a number', () => {
    expect(clampResponse(Number.NaN)).toBe(1);
    expect(clampResponse(Infinity)).toBe(1);
  });
});

describe('columnStats / standardize', () => {
  test('reports the per-column mean and population sd', () => {
    const { mean, std } = columnStats([[0, 10], [10, 10], [20, 10]]);
    expect(mean).toEqual([10, 10]);
    expect(std[0]!).toBeCloseTo(Math.sqrt(200 / 3), 9);
  });

  // A dead column would otherwise divide the whole row by zero.
  test('floors the sd of a column that never moves', () => {
    expect(columnStats([[5], [5], [5]]).std[0]!).toBe(EPS);
  });

  test('standardizes the training rows to zero mean and unit spread', () => {
    const rows = [[1], [3], [5]];
    const s = columnStats(rows);
    const z = rows.map((r) => standardize(r, s)[0]!);
    expect(z.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9);
    expect(z[2]!).toBeCloseTo(-z[0]!, 9);
  });

  test('stays finite on a constant column', () => {
    expect(standardize([5], columnStats([[5], [5]])).every(Number.isFinite)).toBe(true);
  });
});

describe('shuffled', () => {
  test('is a permutation, not a rewrite', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect([...shuffled(items)].sort((a, b) => a - b)).toEqual(items);
  });

  test('is deterministic for a seed, and different across seeds', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(shuffled(items, 7)).toEqual(shuffled(items, 7));
    expect(shuffled(items, 7)).not.toEqual(shuffled(items, 8));
  });

  test('does not reorder the caller array', () => {
    const items = [1, 2, 3, 4, 5];
    shuffled(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  test('actually moves something', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(shuffled(items)).not.toEqual(items);
  });
});

describe('assignFolds', () => {
  const rows = [
    ...Array.from({ length: 10 }, () => row('shoot-a')),
    ...Array.from({ length: 6 }, () => row('shoot-b')),
    ...Array.from({ length: 4 }, () => row('shoot-c')),
    ...Array.from({ length: 2 }, () => row('shoot-d')),
  ];

  test('keeps a whole shoot on one side of the split', () => {
    const folds = assignFolds(rows, 3, 'folder');
    const byGroup = new Map<string, Set<number>>();
    rows.forEach((r, i) => {
      if (!byGroup.has(r.group)) byGroup.set(r.group, new Set());
      byGroup.get(r.group)!.add(folds[i]!);
    });
    for (const assigned of byGroup.values()) expect(assigned.size).toBe(1);
  });

  test('balances the folds by putting the largest shoot in the lightest one', () => {
    const folds = assignFolds(rows, 3, 'folder');
    const load = [0, 0, 0];
    for (const f of folds) load[f]! += 1;
    expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(6);
  });

  test('is deterministic', () => {
    expect(assignFolds(rows, 3, 'folder')).toEqual(assignFolds(rows, 3, 'folder'));
    expect(assignFolds(rows, 3, 'none')).toEqual(assignFolds(rows, 3, 'none'));
  });

  test('assigns every row to a valid fold', () => {
    for (const mode of GROUP_BY_MODES) {
      const folds = assignFolds(rows, 4, mode);
      expect(folds.length).toBe(rows.length);
      expect(folds.every((f) => f >= 0 && f < 4)).toBe(true);
    }
  });

  // The leakage-prone split, kept only for comparison.
  test('the ungrouped policy does split a shoot, which is the point of the comparison', () => {
    const single = Array.from({ length: 20 }, () => row('one-shoot'));
    expect(new Set(assignFolds(single, 4, 'none')).size).toBeGreaterThan(1);
    expect(new Set(assignFolds(single, 4, 'folder')).size).toBe(1);
  });

  test('handles an empty set', () => {
    expect(assignFolds([], 4, 'folder')).toEqual([]);
    expect(assignFolds([], 4, 'none')).toEqual([]);
  });
});

describe('degenerateTargets', () => {
  test('flags a target that never moves', () => {
    const rows = [row('a', [5, 1]), row('b', [5, 2]), row('c', [5, 3])];
    expect(degenerateTargets(rows, 2)).toEqual([true, false]);
  });

  test('does not flag a target that moves by a hair', () => {
    const rows = [row('a', [0]), row('b', [1e-6])];
    expect(degenerateTargets(rows, 1)).toEqual([false]);
  });

  test('flags nothing when there is nothing to look at', () => {
    expect(degenerateTargets([], 3)).toEqual([false, false, false]);
  });

  test('reports one flag per parameter', () => {
    expect(degenerateTargets([row('a', [1, 2, 3])], 3).length).toBe(3);
  });
});

describe('weightedSkill', () => {
  const heavy = [param('Exposure2012'), param('Contrast2012')]; // weights 3.0 and 2.0
  const light = param('ShadowTint'); // weight 0.5

  test('weights each parameter by its own importance', () => {
    const skill = weightedSkill([stat(0.3), stat(0.1)], heavy, [false, false])!;
    expect(skill).toBeCloseTo((3 * 0.3 + 2 * 0.1) / 5, 9);
  });

  // Style constants collapse to the photographer's mean by design; letting them
  // into the headline would report the collapse as a result.
  test('ignores the low-weight style constants', () => {
    const params = [param('Exposure2012'), light];
    expect(weightedSkill([stat(0.2), stat(0.9)], params, [false, false])!).toBeCloseTo(0.2, 9);
  });

  test('excludes a degenerate target — a perfectly predicted constant is not skill', () => {
    expect(weightedSkill([stat(0.2), stat(1)], heavy, [false, true])!).toBeCloseTo(0.2, 9);
  });

  test('excludes a parameter with no baseline error to improve on', () => {
    const stats = [stat(0.2), stat(1, 0)];
    expect(weightedSkill(stats, heavy, [false, false])!).toBeCloseTo(0.2, 9);
  });

  test('is null rather than zero when nothing qualifies', () => {
    expect(weightedSkill([stat(0.9)], [light], [false])).toBeNull();
    expect(weightedSkill([], [], [])).toBeNull();
  });

  test('reports a negative headline honestly', () => {
    expect(weightedSkill([stat(-0.1)], [param('Exposure2012')], [false])!).toBeCloseTo(-0.1, 9);
  });
});
