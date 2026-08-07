/**
 * The arithmetic behind `develop feedback`.
 *
 * The metric that matters is `engagedAcceptance`, not `acceptance`. Most
 * parameters are gated to the photographer's mean, which sits near neutral, so
 * counting "we both left this at zero" as agreement put the headline at 55%
 * before the engaged denominator existed. These tests pin that distinction, and
 * the journey score that describes a *starting point* rather than a hit or miss.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildObservation,
  minMovedFloor,
  neutralOf,
  RELIABLE_SAMPLE,
  summarize,
  tolerance,
} from '../../src/develop/feedback/stats.js';
import {
  CURVE_KNOTS,
  curveParamKey,
  DEVELOP_PARAMS,
  type DevelopParam,
} from '../../src/develop/develop/schema.js';
import type { FeedbackObservation } from '../../src/develop/feedback/journal.js';
import type { Prediction } from '../../src/develop/predict.js';

const param = (key: string): DevelopParam => DEVELOP_PARAMS.find((p) => p.key === key)!;

const observation = (
  predicted: Record<string, number>,
  actual: Record<string, number>,
  file = 'IMG_1.cr3',
): FeedbackObservation =>
  ({ file, at: '2026-08-02T00:00:00.000Z', run: 'r', predicted, actual }) as FeedbackObservation;

const rowFor = (obs: FeedbackObservation[], key: string) =>
  summarize(obs).params.find((p) => p.key === key)!;

describe('tolerance', () => {
  test('matches how the sidecar writes each parameter', () => {
    expect(tolerance('Exposure2012')).toBe(0.005);
    expect(tolerance('Contrast2012')).toBe(0.5);
    expect(tolerance(curveParamKey(128))).toBe(0.5);
  });
});

describe('neutralOf', () => {
  test('is zero for an ordinary slider', () => {
    expect(neutralOf(param('Contrast2012'))).toBe(0);
    expect(neutralOf(param('Exposure2012'))).toBe(0);
  });

  test('is the identity curve for a knot — y = x, not zero', () => {
    for (const knot of CURVE_KNOTS) expect(neutralOf(param(curveParamKey(knot)))).toBe(knot);
  });
});

describe('buildObservation', () => {
  const prediction = (develop: Record<string, number>): Prediction =>
    ({ file: 'IMG_1.cr3', develop, treatment: 'color' }) as unknown as Prediction;

  test('pairs each predicted parameter with what the photographer left', () => {
    const obs = buildObservation(
      prediction({ Contrast2012: 20, Exposure2012: 0.5 }),
      { Contrast2012: 25, Exposure2012: 0.5 },
      { at: 'now', run: 'r' },
    );
    expect(obs.predicted).toEqual({ Contrast2012: 20, Exposure2012: 0.5 });
    expect(obs.actual).toEqual({ Contrast2012: 25, Exposure2012: 0.5 });
  });

  // Not missing data: the photographer looked at it and left it.
  test('reads a slider absent from the edit as sitting at its neutral', () => {
    const obs = buildObservation(
      prediction({ Contrast2012: 20, [curveParamKey(128)]: 140 }),
      {},
      { at: 'now', run: 'r' },
    );
    expect(obs.actual.Contrast2012).toBe(0);
    expect(obs.actual[curveParamKey(128)]).toBe(128);
  });

  test('says nothing about parameters the model did not predict', () => {
    const obs = buildObservation(prediction({ Contrast2012: 20 }), { Dehaze: 40 }, { at: 'now', run: 'r' });
    expect(Object.keys(obs.predicted)).toEqual(['Contrast2012']);
    expect('Dehaze' in obs.actual).toBe(false);
  });

  test('drops a non-finite current value rather than recording it', () => {
    const obs = buildObservation(
      prediction({ Contrast2012: 20 }),
      { Contrast2012: Number.NaN },
      { at: 'now', run: 'r' },
    );
    expect('Contrast2012' in obs.predicted).toBe(false);
  });

  test('carries the provenance it was given, and omits what it was not', () => {
    const bare = buildObservation(prediction({}), {}, { at: 'now', run: 'r' });
    expect('predictedAt' in bare).toBe(false);
    expect('actualRender' in bare).toBe(false);

    const full = buildObservation(prediction({}), {}, {
      at: 'now',
      run: 'r',
      predictedAt: 'earlier',
      render: { profile: 'Adobe Standard' },
    });
    expect(full.predictedAt).toBe('earlier');
    expect(full.actualRender).toBe('Adobe Standard');
  });
});

describe('summarize', () => {
  test('counts a prediction the photographer left alone as kept', () => {
    const row = rowFor([observation({ Contrast2012: 20 }, { Contrast2012: 20.4 })], 'Contrast2012');
    expect(row.compared).toBe(1);
    expect(row.kept).toBe(1);
    expect(row.engagedKept).toBe(1);
  });

  test('counts a change past the tolerance as a correction', () => {
    const row = rowFor([observation({ Contrast2012: 20 }, { Contrast2012: 30 })], 'Contrast2012');
    expect(row.kept).toBe(0);
    expect(row.bias).toBe(10);
    expect(row.spread).toBe(10);
  });

  test('holds exposure to its own, tighter tolerance', () => {
    const kept = rowFor([observation({ Exposure2012: 0.5 }, { Exposure2012: 0.503 })], 'Exposure2012');
    const moved = rowFor([observation({ Exposure2012: 0.5 }, { Exposure2012: 0.52 })], 'Exposure2012');
    expect(kept.kept).toBe(1);
    expect(moved.kept).toBe(0);
  });

  // The correction the whole engaged denominator exists for.
  test('does not count agreeing that a slider stays at neutral', () => {
    const row = rowFor([observation({ Contrast2012: 0 }, { Contrast2012: 0 })], 'Contrast2012');
    expect(row.compared).toBe(1);
    expect(row.kept).toBe(1);
    expect(row.engaged).toBe(0);
    expect(row.engagedKept).toBe(0);
  });

  test('counts it when either side moved the slider', () => {
    const modelMoved = rowFor([observation({ Contrast2012: 30 }, { Contrast2012: 0 })], 'Contrast2012');
    const humanMoved = rowFor([observation({ Contrast2012: 0 }, { Contrast2012: 30 })], 'Contrast2012');
    expect(modelMoved.engaged).toBe(1);
    expect(humanMoved.engaged).toBe(1);
  });

  test('reports both denominators, the flattering one and the product one', () => {
    const summary = summarize([
      observation({ Contrast2012: 0, Dehaze: 30 }, { Contrast2012: 0, Dehaze: 0 }),
    ]);
    // Contrast agreed at neutral (kept, not engaged); Dehaze was corrected.
    expect(summary.acceptance).toBeCloseTo(0.5, 9);
    expect(summary.engagedAcceptance).toBe(0);
  });

  test('signs the bias, so a systematic offset is visible', () => {
    const row = rowFor(
      [
        observation({ Contrast2012: 20 }, { Contrast2012: 30 }, 'a'),
        observation({ Contrast2012: 20 }, { Contrast2012: 40 }, 'b'),
      ],
      'Contrast2012',
    );
    expect(row.bias).toBe(15);
    expect(row.spread).toBe(15);
  });

  test('averages the correction over the corrections, not over everything', () => {
    const row = rowFor(
      [
        observation({ Contrast2012: 20 }, { Contrast2012: 20 }, 'kept'),
        observation({ Contrast2012: 20 }, { Contrast2012: 30 }, 'moved'),
      ],
      'Contrast2012',
    );
    expect(row.compared).toBe(2);
    expect(row.bias).toBe(10);
  });

  test('scores the journey: most of the way there is neither a hit nor a miss', () => {
    // Predicted 38 where the photographer wanted 42, from a neutral of 0.
    const row = rowFor([observation({ Contrast2012: 38 }, { Contrast2012: 42 })], 'Contrast2012');
    expect(row.journey).toBeCloseTo(1 - 4 / 42, 9);
  });

  test('scores a perfect prediction at one and a doubly-wrong one below zero', () => {
    const perfect = rowFor([observation({ Contrast2012: 40 }, { Contrast2012: 40 })], 'Contrast2012');
    expect(perfect.journey).toBe(1);

    // Predicted +40 where the answer was −40: worse than having done nothing.
    const backwards = rowFor([observation({ Contrast2012: 40 }, { Contrast2012: -40 })], 'Contrast2012');
    expect(backwards.journey).toBeLessThan(0);
  });

  test('measures the journey of a curve knot against the identity, not against zero', () => {
    const key = curveParamKey(128);
    const row = rowFor([observation({ [key]: 150 }, { [key]: 152 })], key);
    expect(row.journey).toBeCloseTo(1 - 2 / 24, 9);
  });

  test('counts an image where nothing at all was corrected', () => {
    const summary = summarize([
      observation({ Contrast2012: 20 }, { Contrast2012: 20 }, 'a'),
      observation({ Contrast2012: 20 }, { Contrast2012: 60 }, 'b'),
    ]);
    expect(summary.images).toBe(2);
    expect(summary.untouched).toBe(1);
  });

  test('reports the parameters in schema order, and only the ones compared', () => {
    const summary = summarize([observation({ Contrast2012: 5, Exposure2012: 1 }, { Contrast2012: 5, Exposure2012: 1 })]);
    expect(summary.params.map((p) => p.key)).toEqual(['Exposure2012', 'Contrast2012']);
  });

  test('names the group each parameter belongs to, for the report sections', () => {
    expect(rowFor([observation({ Contrast2012: 5 }, { Contrast2012: 5 })], 'Contrast2012').group).toBe('tone');
  });

  test('handles an empty pool without dividing by zero', () => {
    expect(summarize([])).toEqual({
      images: 0,
      untouched: 0,
      acceptance: 0,
      engagedAcceptance: 0,
      params: [],
    });
  });
});

describe('minMovedFloor', () => {
  test('never demands more than a quarter of the pool', () => {
    expect(minMovedFloor(40)).toBe(10);
    expect(minMovedFloor(24)).toBe(6);
  });

  // A flat 20 made the table unconditionally empty on a ten-frame shoot, which
  // arrived looking like a broken command rather than "your set is too small".
  test('never demands more than a small shoot can supply', () => {
    expect(minMovedFloor(10)).toBe(3);
    expect(minMovedFloor(1)).toBe(3);
    expect(minMovedFloor(0)).toBe(3);
  });

  test('caps at what a large pool can afford anyway', () => {
    expect(minMovedFloor(1000)).toBe(RELIABLE_SAMPLE);
    expect(RELIABLE_SAMPLE).toBe(20);
  });

  test('is monotone in the pool size', () => {
    let previous = 0;
    for (const n of [0, 5, 12, 40, 80, 200]) {
      const floor = minMovedFloor(n);
      expect(floor).toBeGreaterThanOrEqual(previous);
      previous = floor;
    }
  });
});
