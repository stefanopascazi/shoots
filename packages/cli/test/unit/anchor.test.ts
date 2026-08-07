/**
 * Anchored prediction: a slider as a correction toward a target.
 *
 * The shape is `ȳ + gain·(x − x̄)` with an optional dead zone and a separate
 * slope below it, and the whole reason it exists is that it is *unshrunk* — a
 * frame far from the photographer's typical scene must get a proportionally
 * large correction by arithmetic, without the fit ever having seen one that
 * extreme. So the tests check reach, not average error.
 */
import { describe, expect, test } from 'bun:test';
import { COLOR_FEATURE_NAMES } from '@shoots/imaging';
import {
  ANCHORS,
  anchorApply,
  anchorValue,
  fitAnchor,
  predictAnchor,
  type AnchorModel,
  type AnchorSample,
} from '../../src/develop/train/anchor.js';
import { DEVELOP_PARAMS, type AsShotMeta, type DevelopParam } from '../../src/develop/develop/schema.js';

const param = (key: string): DevelopParam => DEVELOP_PARAMS.find((p) => p.key === key)!;

const META: AsShotMeta = {
  tempAsShot: 5500,
  tintAsShot: 0,
  iso: 100,
  exposureComp: 0,
  camera: 'test',
};

const model = (over: Partial<AnchorModel> = {}): AnchorModel => ({
  feature: 'lumaMean',
  index: 0,
  xbar: 0.5,
  ybar: 0,
  gain: -2,
  tailSkill: 0.1,
  skill: 0.05,
  ...over,
});

describe('ANCHORS', () => {
  test('offers candidates only for parameters the schema declares', () => {
    const keys = new Set(DEVELOP_PARAMS.map((p) => p.key));
    for (const key of Object.keys(ANCHORS)) expect(keys.has(key)).toBe(true);
  });

  test('names only real colour features', () => {
    for (const specs of Object.values(ANCHORS)) {
      for (const spec of specs) expect(COLOR_FEATURE_NAMES).toContain(spec.feature);
    }
  });

  test('offers at least one candidate per anchored parameter', () => {
    for (const specs of Object.values(ANCHORS)) expect(specs.length).toBeGreaterThan(0);
  });

  test('measures exposure multiplicatively — a stop is a doubling', () => {
    expect(ANCHORS.Exposure2012!.every((s) => s.log2 === true)).toBe(true);
  });
});

describe('anchorApply', () => {
  test('returns the photographer average at the anchor centre', () => {
    expect(anchorApply({ xbar: 0.5, ybar: 10, gain: -2 }, 0.5)).toBe(10);
  });

  test('is a straight line through the centre with no dead zone', () => {
    const m = { xbar: 0, ybar: 0, gain: 3 };
    expect(anchorApply(m, 2)).toBe(6);
    expect(anchorApply(m, -2)).toBe(-6);
  });

  test('does not move inside the dead zone', () => {
    const m = { xbar: 0, ybar: 5, gain: 10, deadband: 1 };
    expect(anchorApply(m, 0)).toBe(5);
    expect(anchorApply(m, 0.9)).toBe(5);
    expect(anchorApply(m, -1)).toBe(5);
  });

  test('starts correcting from the edge of the dead zone, not from the centre', () => {
    const m = { xbar: 0, ybar: 0, gain: 10, deadband: 1 };
    expect(anchorApply(m, 2)).toBe(10); // (2 − 1) × 10
    expect(anchorApply(m, -2)).toBe(-10);
  });

  test('uses the below-zone slope on the other side when there is one', () => {
    const m = { xbar: 0, ybar: 0, gain: 10, gainBelow: 1, deadband: 0 };
    expect(anchorApply(m, 2)).toBe(20);
    expect(anchorApply(m, -2)).toBe(-2);
  });

  // The property de-shrinking cannot supply: reach grows with the evidence.
  test('reaches proportionally further the further the frame sits from the centre', () => {
    const m = { xbar: 0, ybar: 0, gain: -1.5 };
    expect(anchorApply(m, 4)).toBe(anchorApply(m, 2) * 2);
  });
});

describe('anchorValue', () => {
  const colour = COLOR_FEATURE_NAMES.map((_, i) => (i + 1) / 100);

  test('reads the feature at its index', () => {
    expect(anchorValue({ feature: 'lumaMean', index: 3 }, colour)).toBe(colour[3]);
  });

  test('reads it in log2 when the spec asks for it', () => {
    expect(anchorValue({ feature: 'lumaMean', index: 3, log2: true }, colour)).toBeCloseTo(
      Math.log2(colour[3]!),
      12,
    );
  });

  test('is null rather than -Infinity for a log2 feature at zero', () => {
    expect(anchorValue({ feature: 'lumaMean', index: 0, log2: true }, [0, 1])).toBeNull();
  });

  test('is null when the vector is too short or carries a non-number', () => {
    expect(anchorValue({ feature: 'lumaMean', index: 99 }, colour)).toBeNull();
    expect(anchorValue({ feature: 'lumaMean', index: 0 }, [Number.NaN])).toBeNull();
  });

  test('reads a legitimate zero on a linear feature', () => {
    expect(anchorValue({ feature: 'clipHigh', index: 0 }, [0, 1])).toBe(0);
  });
});

describe('predictAnchor', () => {
  const colour = COLOR_FEATURE_NAMES.map(() => 0.5);

  test('replays the fitted shape for one photograph', () => {
    const bright = colour.slice();
    bright[0] = 0.9;
    expect(predictAnchor(param('Exposure2012'), model({ gain: -2 }), bright, META)).toBeCloseTo(
      -2 * (0.9 - 0.5),
      6,
    );
  });

  test('clamps into the range the editor accepts', () => {
    const extreme = colour.slice();
    extreme[0] = 100;
    expect(predictAnchor(param('Exposure2012'), model({ gain: -2 }), extreme, META)).toBe(-5);
    expect(predictAnchor(param('Exposure2012'), model({ gain: 2 }), extreme, META)).toBe(5);
  });

  test('is null when the anchor feature cannot be read', () => {
    expect(predictAnchor(param('Exposure2012'), model({ index: 999 }), colour, META)).toBeNull();
  });
});

describe('fitAnchor', () => {
  const SPEC = { feature: 'lumaMean' };
  const OPTS = { folds: 4, shuffles: 3, maeAllowance: 0.05 };

  /** A catalog where the slider genuinely tracks the feature, shoot by shoot. */
  const learnable = (n = 200, slope = -8): AnchorSample[] =>
    Array.from({ length: n }, (_, i) => {
      const x = (i % 20) / 20;
      return { x, y: slope * (x - 0.5), group: `shoot-${Math.floor(i / 10)}` };
    });

  test('learns the slope when the relationship is real', () => {
    const fit = fitAnchor(param('Contrast2012'), SPEC, 0, learnable(), OPTS)!;
    expect(fit).not.toBeNull();
    expect(fit.model.gain).toBeLessThan(0);
    expect(fit.model.xbar).toBeCloseTo(0.475, 2);
  });

  test('keeps an anchor whose tail skill is real', () => {
    expect(fitAnchor(param('Contrast2012'), SPEC, 0, learnable(), OPTS)!.keep).toBe(true);
  });

  test('refuses to keep an anchor fitted on pure noise', () => {
    const noise: AnchorSample[] = Array.from({ length: 200 }, (_, i) => ({
      x: ((i * 7919) % 101) / 100,
      y: ((i * 104729) % 97) - 48,
      group: `shoot-${Math.floor(i / 10)}`,
    }));
    const fit = fitAnchor(param('Contrast2012'), SPEC, 0, noise, OPTS);
    expect(fit === null || fit.keep === false).toBe(true);
  });

  test('declines a set too small to measure on', () => {
    expect(fitAnchor(param('Contrast2012'), SPEC, 0, learnable(50), OPTS)).toBeNull();
  });

  test('declines a slider that never moves — nothing to predict', () => {
    const flat = learnable(200).map((r) => ({ ...r, y: 0 }));
    expect(fitAnchor(param('Contrast2012'), SPEC, 0, flat, OPTS)).toBeNull();
  });

  test('declines a feature that never moves — nothing to read', () => {
    const flat = learnable(200).map((r) => ({ ...r, x: 0.5 }));
    expect(fitAnchor(param('Contrast2012'), SPEC, 0, flat, OPTS)).toBeNull();
  });

  test('records the anchor spec and its column on the fitted model', () => {
    const fit = fitAnchor(param('Contrast2012'), { feature: 'lumaMean', log2: true }, 7, learnable(), OPTS)!;
    expect(fit.model.feature).toBe('lumaMean');
    expect(fit.model.log2).toBe(true);
    expect(fit.model.index).toBe(7);
  });

  test('reports both skills, and rounds what it stores', () => {
    const { model: m } = fitAnchor(param('Contrast2012'), SPEC, 0, learnable(), OPTS)!;
    expect(Number.isFinite(m.tailSkill)).toBe(true);
    expect(Number.isFinite(m.skill)).toBe(true);
    expect(Math.round(m.gain * 1e6) / 1e6).toBe(m.gain);
    expect(Math.round(m.tailSkill * 1e4) / 1e4).toBe(m.tailSkill);
  });

  test('is deterministic — the same rows fit the same anchor', () => {
    const rows = learnable();
    expect(fitAnchor(param('Contrast2012'), SPEC, 0, rows, OPTS)).toEqual(
      fitAnchor(param('Contrast2012'), SPEC, 0, rows, OPTS),
    );
  });

  test('omits the dead zone and the second slope when they carry nothing', () => {
    const rows = learnable(200, -8);
    const { model: m } = fitAnchor(param('Contrast2012'), SPEC, 0, rows, OPTS)!;
    if (m.deadband !== undefined) expect(m.deadband).toBeGreaterThan(0);
    if (m.gainBelow !== undefined) expect(m.gainBelow).not.toBe(m.gain);
  });
});
