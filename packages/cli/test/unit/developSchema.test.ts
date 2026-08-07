/**
 * The develop target vector — the numeric contract the predictor learns.
 *
 * Two things here are load-bearing beyond their size: the *order* of
 * DEVELOP_PARAMS (a profile's weights are indexed by position, so a reordering
 * silently mis-reads every stored profile) and the delta encode/decode pair,
 * which is what makes a predicted number mean the same thing on two cameras.
 */
import { describe, expect, test } from 'bun:test';
import {
  CURVE_KNOTS,
  curveFromDevelop,
  curveParamKey,
  decodeDelta,
  DEVELOP_PARAMS,
  encodeDelta,
  HSL_CHANNELS,
  parseRenderKey,
  paramsForTreatment,
  renderKey,
  sampleCurve,
  SCHEMA_VERSION,
  treatmentFromDevelop,
  withCurveTargets,
  type AsShotMeta,
  type DevelopParam,
} from '../../src/develop/develop/schema.js';

const META: AsShotMeta = {
  tempAsShot: 5000,
  tintAsShot: 10,
  iso: 400,
  exposureComp: 0,
  camera: 'Canon EOS R5',
};

const NO_WB: AsShotMeta = { ...META, tempAsShot: null, tintAsShot: null };

const param = (key: string): DevelopParam => {
  const found = DEVELOP_PARAMS.find((p) => p.key === key);
  if (!found) throw new Error(`no such param: ${key}`);
  return found;
};

describe('DEVELOP_PARAMS', () => {
  test('names every key exactly once', () => {
    expect(new Set(DEVELOP_PARAMS.map((p) => p.key)).size).toBe(DEVELOP_PARAMS.length);
  });

  test('groups the branches: shared first, then colour, then B&W', () => {
    const branches = DEVELOP_PARAMS.map((p) => p.branch);
    const firstColor = branches.indexOf('color');
    const firstBw = branches.indexOf('bw');
    expect(branches.lastIndexOf('shared')).toBeLessThan(firstColor);
    expect(branches.lastIndexOf('color')).toBeLessThan(firstBw);
  });

  test('gives every parameter a usable range and a positive weight', () => {
    for (const p of DEVELOP_PARAMS) {
      expect(p.absMin).toBeLessThan(p.absMax);
      expect(p.weight).toBeGreaterThan(0);
    }
  });

  test('carries the nine curve knots as shared parameters', () => {
    for (const knot of CURVE_KNOTS) {
      const p = param(curveParamKey(knot));
      expect(p.branch).toBe('shared');
      expect(p.ref).toBe('const');
      expect(p.refConst).toBe(knot);
    }
  });

  test('carries all eight HSL channels on each of the three aspects', () => {
    for (const aspect of ['HueAdjustment', 'SaturationAdjustment', 'LuminanceAdjustment']) {
      for (const ch of HSL_CHANNELS) expect(param(`${aspect}${ch}`).branch).toBe('color');
    }
  });

  test('puts the whole gray mixer on the B&W branch', () => {
    for (const ch of HSL_CHANNELS) expect(param(`GrayMixer${ch}`).branch).toBe('bw');
  });

  test('anchors white balance to the capture, not to zero', () => {
    expect(param('Temperature').ref).toBe('asShotTemp');
    expect(param('Temperature').transform).toBe('logK');
    expect(param('Tint').ref).toBe('asShotTint');
  });

  test('pins the schema version, which every stored profile is read against', () => {
    expect(SCHEMA_VERSION).toBe(9);
  });
});

describe('paramsForTreatment', () => {
  test('gives colour the shared block plus the colour branch', () => {
    const branches = new Set(paramsForTreatment('color').map((p) => p.branch));
    expect(branches).toEqual(new Set(['shared', 'color']));
  });

  test('gives B&W the shared block plus the mixer', () => {
    const branches = new Set(paramsForTreatment('bw').map((p) => p.branch));
    expect(branches).toEqual(new Set(['shared', 'bw']));
  });

  test('keeps the two branches mutually exclusive', () => {
    const color = new Set(paramsForTreatment('color').map((p) => p.key));
    const bw = paramsForTreatment('bw').map((p) => p.key);
    expect(bw.some((k) => k.startsWith('GrayMixer'))).toBe(true);
    expect(bw.filter((k) => k.startsWith('GrayMixer')).every((k) => !color.has(k))).toBe(true);
  });

  test('preserves the global order within each treatment', () => {
    const positions = paramsForTreatment('color').map((p) => DEVELOP_PARAMS.indexOf(p));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('treatmentFromDevelop', () => {
  test('honours the explicit flag in both directions', () => {
    expect(treatmentFromDevelop({ ConvertToGrayscale: 1 })).toBe('bw');
    expect(treatmentFromDevelop({ ConvertToGrayscale: 0 })).toBe('color');
  });

  // The trap: a colour photo where a B&W look was tried and switched back off
  // still carries mixer values. The flag has to win.
  test('the flag beats a leftover gray mixer', () => {
    expect(treatmentFromDevelop({ ConvertToGrayscale: 0, GrayMixerRed: 40 })).toBe('color');
  });

  test('falls back to the mixer only when the flag is silent', () => {
    expect(treatmentFromDevelop({ GrayMixerBlue: -20 })).toBe('bw');
  });

  test('an edit that says nothing is colour', () => {
    expect(treatmentFromDevelop({})).toBe('color');
    expect(treatmentFromDevelop({ Exposure2012: 0.5 })).toBe('color');
  });
});

describe('encodeDelta / decodeDelta', () => {
  test('a plain slider is its own delta', () => {
    const p = param('Contrast2012');
    expect(encodeDelta(p, 25, META)).toBe(25);
    expect(decodeDelta(p, 25, META)).toBe(25);
  });

  test('temperature is a log-Kelvin delta against the capture', () => {
    const p = param('Temperature');
    expect(encodeDelta(p, 5000, META)).toBeCloseTo(0, 12);
    expect(encodeDelta(p, 10000, META)).toBeCloseTo(Math.log(2), 12);
  });

  test('the same warming means the same delta on two different captures', () => {
    const p = param('Temperature');
    const cool: AsShotMeta = { ...META, tempAsShot: 4000 };
    const warm: AsShotMeta = { ...META, tempAsShot: 6000 };
    const d = encodeDelta(p, 4400, cool);
    expect(encodeDelta(p, 6600, warm)).toBeCloseTo(d, 10);
  });

  test('tint is an offset against the as-shot tint', () => {
    const p = param('Tint');
    expect(encodeDelta(p, 30, META)).toBe(20);
    expect(decodeDelta(p, 20, META)).toBe(30);
  });

  test('a curve knot is a delta against the identity', () => {
    const p = param(curveParamKey(128));
    expect(encodeDelta(p, 128, META)).toBe(0);
    expect(encodeDelta(p, 150, META)).toBe(22);
    expect(decodeDelta(p, 22, META)).toBe(150);
  });

  test('round-trips every parameter', () => {
    for (const p of DEVELOP_PARAMS) {
      const mid = (p.absMin + p.absMax) / 2;
      expect(decodeDelta(p, encodeDelta(p, mid, META), META)).toBeCloseTo(mid, 6);
    }
  });

  test('falls back to 5500 K and tint 0 when the capture recorded neither', () => {
    expect(encodeDelta(param('Temperature'), 5500, NO_WB)).toBeCloseTo(0, 12);
    expect(encodeDelta(param('Tint'), 15, NO_WB)).toBe(15);
  });

  test('decoding clamps back into the range ACR accepts', () => {
    const p = param('Exposure2012');
    expect(decodeDelta(p, 100, META)).toBe(5);
    expect(decodeDelta(p, -100, META)).toBe(-5);
  });

  test('never takes the log of zero', () => {
    expect(Number.isFinite(encodeDelta(param('Temperature'), 0, { ...META, tempAsShot: 0 }))).toBe(true);
  });
});

describe('sampleCurve', () => {
  test('an absent or degenerate curve is the identity', () => {
    expect(sampleCurve(undefined)).toEqual([...CURVE_KNOTS]);
    expect(sampleCurve([0, 0])).toEqual([...CURVE_KNOTS]);
  });

  test('samples the identity line back as itself', () => {
    expect(sampleCurve([0, 0, 255, 255])).toEqual([...CURVE_KNOTS]);
  });

  test('interpolates linearly between the given points', () => {
    // A straight line of slope 2 through the origin, clipped by the endpoints.
    const sampled = sampleCurve([0, 0, 128, 255]);
    expect(sampled[0]).toBe(0);
    expect(sampled[4]).toBeCloseTo(255, 6); // x = 128
    expect(sampled[2]).toBeCloseTo(127.5, 6); // x = 64
  });

  test('holds the endpoints flat beyond the curve', () => {
    const sampled = sampleCurve([64, 10, 192, 200]);
    expect(sampled[0]).toBe(10); // x = 0, before the first point
    expect(sampled[sampled.length - 1]).toBe(200); // x = 255, past the last
  });

  test('sorts unordered points before sampling', () => {
    expect(sampleCurve([255, 255, 0, 0])).toEqual([...CURVE_KNOTS]);
  });
});

describe('withCurveTargets', () => {
  test('materializes one target per knot without touching the rest', () => {
    const out = withCurveTargets({ Exposure2012: 0.5 }, [0, 0, 255, 255]);
    expect(out.Exposure2012).toBe(0.5);
    for (const knot of CURVE_KNOTS) expect(out[curveParamKey(knot)]).toBe(knot);
  });

  test('does not mutate the caller map', () => {
    const develop = { Exposure2012: 0.5 };
    withCurveTargets(develop, undefined);
    expect(Object.keys(develop)).toEqual(['Exposure2012']);
  });
});

describe('curveFromDevelop', () => {
  test('says nothing when the prediction is the identity', () => {
    const develop = withCurveTargets({}, undefined);
    expect(curveFromDevelop(develop)).toBeUndefined();
  });

  test('says nothing when a knot is missing or not a number', () => {
    expect(curveFromDevelop({})).toBeUndefined();
    const partial = withCurveTargets({}, undefined);
    partial[curveParamKey(128)] = Number.NaN;
    expect(curveFromDevelop(partial)).toBeUndefined();
  });

  test('emits a flattened [x,y,…] curve when a knot moved', () => {
    const develop = withCurveTargets({}, undefined);
    develop[curveParamKey(128)] = 160;
    const curve = curveFromDevelop(develop)!;

    expect(curve.length).toBe(CURVE_KNOTS.length * 2);
    expect(curve.filter((_, i) => i % 2 === 0)).toEqual([...CURVE_KNOTS]);
    expect(curve[2 * CURVE_KNOTS.indexOf(128) + 1]).toBe(160);
  });

  // Each knot is fitted independently, so nothing stops a regressor predicting a
  // curve that dips backwards — which ACR renders as a solarized frame.
  test('forces the output non-decreasing', () => {
    const develop = withCurveTargets({}, undefined);
    develop[curveParamKey(64)] = 200;
    develop[curveParamKey(96)] = 10;
    const ys = curveFromDevelop(develop)!.filter((_, i) => i % 2 === 1);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]!);
  });

  test('clamps to the 0..255 the editor accepts and rounds to integers', () => {
    const develop = withCurveTargets({}, undefined);
    develop[curveParamKey(224)] = 900;
    develop[curveParamKey(32)] = 12.6;
    const ys = curveFromDevelop(develop)!.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBe(255);
    expect(ys.every(Number.isInteger)).toBe(true);
  });

  test('ignores a sub-half-point wobble as untouched', () => {
    const develop = withCurveTargets({}, undefined);
    develop[curveParamKey(128)] = 128.4;
    expect(curveFromDevelop(develop)).toBeUndefined();
  });
});

describe('renderKey / parseRenderKey', () => {
  test('is undefined when there is nothing to condition on', () => {
    expect(renderKey(undefined)).toBeUndefined();
    expect(renderKey({})).toBeUndefined();
  });

  test('a bare profile is its own key', () => {
    expect(renderKey({ profile: 'Adobe Standard' })).toBe('Adobe Standard');
  });

  test('joins the profile and the Look, which are stored separately', () => {
    expect(renderKey({ profile: 'Adobe Standard v2', look: 'Adobe Color' })).toBe(
      'Adobe Standard v2 + Adobe Color',
    );
  });

  test('names a Look with no profile rather than dropping it', () => {
    expect(renderKey({ look: 'Adobe Color' })).toBe('(default) + Adobe Color');
  });

  test('round-trips through parseRenderKey', () => {
    for (const render of [
      { profile: 'Adobe Standard' },
      { profile: 'Camera Neutral', look: 'Adobe Vivid' },
    ]) {
      expect(parseRenderKey(renderKey(render)!)).toEqual(render);
    }
  });

  test('reads a bare key as a profile name', () => {
    expect(parseRenderKey('Adobe Standard')).toEqual({ profile: 'Adobe Standard' });
  });
});
