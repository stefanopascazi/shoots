/**
 * How a dataset record becomes the two heads' inputs, and what each head is
 * allowed to look at.
 *
 * The decomposition is the point: the frame head sees a photograph minus its
 * shoot's own average, so it *cannot* answer with the session mean — which is
 * exactly what an entangled regression did, leaving the per-frame columns at a
 * tenth of their honest size. The tests below pin that orthogonality, the
 * circular encoding of the clock, and the masks that narrow each head.
 */
import { describe, expect, test } from 'bun:test';
import { COLOR_FEATURE_NAMES } from '@shoots/imaging';
import {
  actualAbsOne,
  actualAbsVec,
  AS_SHOT_DIM,
  asShotFeatures,
  assembleFeatures,
  baseFeatures,
  deviationFrom,
  renderOneHot,
  targetDeltas,
} from '../../src/develop/develop/assemble.js';
import {
  applyMask,
  featureSetKey,
  frameMask,
  frameWidth,
  levelMask,
  levelWidth,
  type FeatureLayout,
} from '../../src/develop/develop/featureSets.js';
import { DEVELOP_PARAMS, type AsShotMeta, type DevelopParam } from '../../src/develop/develop/schema.js';

const META: AsShotMeta = {
  tempAsShot: 5000,
  tintAsShot: 10,
  iso: 400,
  exposureComp: -0.33,
  camera: 'Canon EOS R5',
  hour: 6,
};

const param = (key: string): DevelopParam => DEVELOP_PARAMS.find((p) => p.key === key)!;

const LAYOUT: FeatureLayout = {
  embedding: 4,
  colour: COLOR_FEATURE_NAMES.length,
  asShot: AS_SHOT_DIM,
  render: 3,
};

describe('asShotFeatures', () => {
  test('emits exactly the declared width', () => {
    expect(asShotFeatures(META).length).toBe(AS_SHOT_DIM);
  });

  test('puts temperature and ISO in log space, where a stop is a step', () => {
    const [logTemp, logIso] = asShotFeatures(META);
    expect(logTemp).toBeCloseTo(Math.log(5000), 12);
    expect(logIso).toBeCloseTo(Math.log(400), 12);

    const doubled = asShotFeatures({ ...META, iso: 800 });
    expect(doubled[1]! - logIso!).toBeCloseTo(Math.log(2), 12);
  });

  test('passes exposure compensation through as it stands', () => {
    expect(asShotFeatures(META)[2]).toBe(-0.33);
  });

  // 23:00 and 01:00 are an hour apart; a raw hour number says twenty-two.
  test('encodes the clock on the unit circle, so midnight is next to 23:00', () => {
    const at23 = asShotFeatures({ ...META, hour: 23 });
    const at1 = asShotFeatures({ ...META, hour: 1 });
    const at13 = asShotFeatures({ ...META, hour: 13 });
    const gap = (a: number[], b: number[]): number => Math.hypot(a[3]! - b[3]!, a[4]! - b[4]!);

    expect(gap(at23, at1)).toBeLessThan(gap(at23, at13));
  });

  test('puts an unknown hour at the origin — equidistant from every time of day', () => {
    for (const meta of [{ ...META, hour: undefined }, { ...META, hour: null }, { ...META, hour: -1 }]) {
      const f = asShotFeatures(meta as AsShotMeta);
      expect(f[3]).toBe(0);
      expect(f[4]).toBe(0);
    }
  });

  test('substitutes daylight and base ISO when the capture recorded neither', () => {
    const f = asShotFeatures({ ...META, tempAsShot: null, iso: null, exposureComp: null });
    expect(f[0]).toBeCloseTo(Math.log(5500), 12);
    expect(f[1]).toBeCloseTo(Math.log(100), 12);
    expect(f[2]).toBe(0);
  });

  test('never takes the log of zero', () => {
    const f = asShotFeatures({ ...META, tempAsShot: 0, iso: 0 });
    expect(f.every(Number.isFinite)).toBe(true);
  });
});

describe('baseFeatures / assembleFeatures', () => {
  test('lays the blocks out embedding first, so a projection can replace it alone', () => {
    const base = baseFeatures([1, 2], [3, 4, 5], META);
    expect(base.slice(0, 2)).toEqual([1, 2]);
    expect(base.slice(2, 5)).toEqual([3, 4, 5]);
    expect(base.length).toBe(2 + 3 + AS_SHOT_DIM);
  });

  test('assembleFeatures inserts the session mean before the as-shot scalars', () => {
    const full = assembleFeatures([1], [2], [9, 9], META);
    expect(full.slice(0, 4)).toEqual([1, 2, 9, 9]);
    expect(full.length).toBe(1 + 1 + 2 + AS_SHOT_DIM);
  });
});

describe('deviationFrom', () => {
  test('subtracts the shoot average column by column', () => {
    expect(deviationFrom([5, 5, 5], [1, 2, 3])).toEqual([4, 3, 2]);
  });

  // The orthogonality the whole two-head split rests on.
  test('a frame at its shoot average deviates by nothing at all', () => {
    const base = baseFeatures([0.1, 0.2], [0.3], META);
    expect(deviationFrom(base, base).every((v) => v === 0)).toBe(true);
  });

  test('treats a missing session column as zero rather than NaN', () => {
    expect(deviationFrom([5, 5], [1])).toEqual([4, 5]);
  });

  test('preserves the width of the frame vector', () => {
    const base = baseFeatures([1, 2, 3], [4], META);
    expect(deviationFrom(base, base.map(() => 0)).length).toBe(base.length);
  });
});

describe('renderOneHot', () => {
  const vocab = ['Adobe Standard', 'Adobe Standard v2 + Adobe Color', 'Camera Neutral'];

  test('sets exactly the column the render names', () => {
    expect(renderOneHot('Camera Neutral', vocab)).toEqual([0, 0, 1]);
  });

  test('is all zeros for a render outside the vocabulary', () => {
    expect(renderOneHot('Something Else', vocab)).toEqual([0, 0, 0]);
  });

  test('is all zeros when there is no render at all', () => {
    expect(renderOneHot(undefined, vocab)).toEqual([0, 0, 0]);
    expect(renderOneHot('', vocab)).toEqual([0, 0, 0]);
  });

  test('always emits one column per vocabulary entry', () => {
    expect(renderOneHot('Adobe Standard', vocab).length).toBe(vocab.length);
    expect(renderOneHot('x', []).length).toBe(0);
  });
});

describe('actualAbsOne / actualAbsVec', () => {
  test('reads a value the edit actually carries', () => {
    expect(actualAbsOne(param('Contrast2012'), { Contrast2012: 25 }, META)).toBe(25);
  });

  test('substitutes the editor default for a parameter the edit omits', () => {
    // Delta zero, decoded: a plain slider's default is 0, WB's is the as-shot value.
    expect(actualAbsOne(param('Contrast2012'), {}, META)).toBe(0);
    expect(actualAbsOne(param('Temperature'), {}, META)).toBeCloseTo(5000, 6);
    expect(actualAbsOne(param('Tint'), {}, META)).toBe(10);
  });

  test('treats a non-finite stored value as absent', () => {
    expect(actualAbsOne(param('Contrast2012'), { Contrast2012: Number.NaN }, META)).toBe(0);
  });

  test('vectorizes in the order it was given the parameters', () => {
    const params = [param('Contrast2012'), param('Exposure2012')];
    expect(actualAbsVec(params, { Contrast2012: 10, Exposure2012: 0.5 }, META)).toEqual([10, 0.5]);
  });
});

describe('targetDeltas', () => {
  test('an untouched edit is all zeros — nothing to learn from it', () => {
    const params = [param('Contrast2012'), param('Temperature'), param('Tint')];
    for (const d of targetDeltas(params, {}, META)) expect(Math.abs(d)).toBeLessThan(1e-9);
  });

  test('states white balance relative to the capture, and everything else absolutely', () => {
    const params = [param('Contrast2012'), param('Temperature')];
    const [contrast, temp] = targetDeltas(params, { Contrast2012: 30, Temperature: 10000 }, META);
    expect(contrast).toBe(30);
    expect(temp).toBeCloseTo(Math.log(2), 6);
  });

  test('emits one delta per parameter, in order', () => {
    const params = [param('Contrast2012'), param('Highlights2012'), param('Shadows2012')];
    expect(targetDeltas(params, { Highlights2012: -40 }, META)).toEqual([0, -40, 0]);
  });
});

describe('featureSetKey', () => {
  test('gives a named parameter its own bucket', () => {
    expect(featureSetKey('Exposure2012', 'tone')).toBe('param:Exposure2012');
    expect(featureSetKey('Vibrance', 'presence')).toBe('param:Vibrance');
  });

  test('falls back to the group for a parameter with no override', () => {
    expect(featureSetKey('Contrast2012', 'tone')).toBe('tone');
    expect(featureSetKey('Temperature', 'wb')).toBe('wb');
  });

  test('buckets an unmeasured group with everything else', () => {
    expect(featureSetKey('GrayMixerRed', 'grayMixer')).toBe('*');
    expect(featureSetKey('SaturationAdjustmentRed', 'hsl')).toBe('*');
  });

  test('parameters sharing a mask share a key', () => {
    expect(featureSetKey('Contrast2012', 'tone')).toBe(featureSetKey('ParametricLights', 'tone'));
  });
});

describe('frameMask / levelMask', () => {
  test('report the widths the heads consume', () => {
    expect(frameWidth(LAYOUT)).toBe(LAYOUT.embedding + LAYOUT.colour + LAYOUT.asShot);
    expect(levelWidth(LAYOUT)).toBe(frameWidth(LAYOUT) + LAYOUT.render);
    expect(frameMask('Exposure2012', 'tone', LAYOUT).length).toBe(frameWidth(LAYOUT));
    expect(levelMask('Exposure2012', 'tone', LAYOUT).length).toBe(levelWidth(LAYOUT));
  });

  test('narrows the frame head to the colour features that answer the question', () => {
    const mask = frameMask('Exposure2012', 'tone', LAYOUT);
    const kept = COLOR_FEATURE_NAMES.filter((_, i) => mask[LAYOUT.embedding + i]);
    expect(kept.sort()).toEqual(['lumaMean', 'lumaMedian', 'lumaP99', 'shadowFloor']);
  });

  test('denies the frame head the embedding where the choice does not follow the subject', () => {
    const exposure = frameMask('Exposure2012', 'tone', LAYOUT);
    expect(exposure.slice(0, LAYOUT.embedding).every((k) => k === false)).toBe(true);

    const texture = frameMask('Texture', 'presence', LAYOUT);
    expect(texture.slice(0, LAYOUT.embedding).every((k) => k === true)).toBe(true);
  });

  test('always lets capture evidence through to the frame head', () => {
    const mask = frameMask('Exposure2012', 'tone', LAYOUT);
    const asShot = mask.slice(LAYOUT.embedding + LAYOUT.colour);
    expect(asShot.length).toBe(AS_SHOT_DIM);
    expect(asShot.every((k) => k === true)).toBe(true);
  });

  // Deliberately not narrowed: this head answers "what kind of shoot is this".
  test('leaves the level head everything but the embedding it is denied', () => {
    const mask = levelMask('Exposure2012', 'tone', LAYOUT);
    expect(mask.slice(0, LAYOUT.embedding).every((k) => k === false)).toBe(true);
    expect(mask.slice(LAYOUT.embedding).every((k) => k === true)).toBe(true);
  });

  test('keeps the render one-hot on the level head', () => {
    const mask = levelMask('Exposure2012', 'tone', LAYOUT);
    expect(mask.slice(-LAYOUT.render).every((k) => k === true)).toBe(true);
  });

  test('an unmeasured group keeps everything, on both heads', () => {
    expect(frameMask('GrayMixerRed', 'grayMixer', LAYOUT).every((k) => k)).toBe(true);
    expect(levelMask('GrayMixerRed', 'grayMixer', LAYOUT).every((k) => k)).toBe(true);
  });

  test('white balance reads the cast, not the brightness', () => {
    const mask = frameMask('Temperature', 'wb', LAYOUT);
    const kept = COLOR_FEATURE_NAMES.filter((_, i) => mask[LAYOUT.embedding + i]);
    expect(kept).toContain('rgRatio');
    expect(kept).toContain('bgRatio');
    expect(kept).not.toContain('lumaMean');
  });
});

describe('applyMask', () => {
  test('zeroes the denied columns and preserves the width', () => {
    expect(applyMask([1, 2, 3], [true, false, true])).toEqual([1, 0, 3]);
  });

  test('an all-true mask is the identity', () => {
    expect(applyMask([1, 2, 3], [true, true, true])).toEqual([1, 2, 3]);
  });

  test('does not mutate the caller row', () => {
    const row = [1, 2, 3];
    applyMask(row, [false, false, false]);
    expect(row).toEqual([1, 2, 3]);
  });
});
