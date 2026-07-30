/**
 * The arithmetic behind `develop feedback`, over a pool of observations.
 *
 * Pure, and deliberately unaware of where the pool came from: it produces the
 * same numbers for one shoot as for the whole journal, which is what lets the
 * report show both without two implementations drifting apart.
 */
import { CURVE_KNOTS, DEVELOP_PARAMS, curveParamKey, renderKey, type DevelopParam, type RenderProfile } from '../develop/schema.js';
import type { Prediction } from '../predict.js';
import type { FeedbackObservation } from './journal.js';

const CURVE_KEYS = new Set(CURVE_KNOTS.map(curveParamKey));

/**
 * How close counts as untouched.
 *
 * The sidecar writes most parameters as integers and exposure to two decimals,
 * so anything inside half a step is the same number that went out, not a
 * decision to leave it alone that happens to look like one.
 */
export function tolerance(key: string): number {
  return key === 'Exposure2012' ? 0.005 : 0.5;
}

/**
 * Where a slider sits when nobody has touched it: the identity for the curve
 * knots, zero for everything else.
 */
export function neutralOf(param: DevelopParam): number {
  return CURVE_KEYS.has(param.key) ? (param.refConst ?? 0) : 0;
}

export interface ParamFeedback {
  key: string;
  group: string;
  /** Images where both a prediction and a current value exist. */
  compared: number;
  /** …of those, how many the photographer left alone. */
  kept: number;
  /**
   * Comparisons where at least one side actually moved the slider.
   *
   * Agreeing that a slider stays at zero is not a prediction anyone made: most
   * parameters are gated to the photographer's mean, which is near neutral, and
   * counting those agreements put acceptance at 55% before this existed. The
   * honest denominator is the set where somebody had an opinion.
   */
  engaged: number;
  /** …of those, how many were left alone. */
  engagedKept: number;
  /** Mean signed correction (actual − predicted) over engaged corrections: an offset. */
  bias: number;
  /** Mean absolute correction over engaged corrections, in slider units. */
  spread: number;
  /**
   * How much of the slider's journey the prediction already covered:
   * `1 − |actual − predicted| / |actual − neutral|`.
   *
   * "Kept within half a unit" is the right bar for *accepted*, but it is a poor
   * description of a starting point. Landing at +38 where the photographer wants
   * +42 is not a hit, and it is not a miss either — it is most of the work done.
   * Negative means the prediction is further from the answer than doing nothing
   * would have been.
   */
  journey: number;
}

export interface FeedbackSummary {
  images: number;
  /** Images where nothing at all was corrected. */
  untouched: number;
  /** Share of every compared parameter left alone — flattering, and the wrong one to quote. */
  acceptance: number;
  /** Share of the parameters *somebody moved* left alone — the product metric. */
  engagedAcceptance: number;
  params: ParamFeedback[];
}

/**
 * The comparison for one photograph, in the form the journal stores.
 *
 * A slider absent from the edit sits at its neutral default, which is a real
 * observation — the photographer looked at it and left it — not missing data.
 */
export function buildObservation(
  prediction: Prediction,
  current: Record<string, number>,
  meta: { at: string; run: string; render?: RenderProfile },
): FeedbackObservation {
  const predicted: Record<string, number> = {};
  const actual: Record<string, number> = {};
  for (const param of DEVELOP_PARAMS) {
    const proposed = prediction.develop[param.key];
    if (proposed === undefined) continue;
    const now = current[param.key] ?? neutralOf(param);
    if (!Number.isFinite(now)) continue;
    predicted[param.key] = proposed;
    actual[param.key] = now;
  }
  const predictedRender = renderKey(prediction.render);
  const actualRender = renderKey(meta.render);
  return {
    file: prediction.file,
    at: meta.at,
    run: meta.run,
    treatment: prediction.treatment,
    predicted,
    actual,
    ...(predictedRender ? { predictedRender } : {}),
    ...(actualRender ? { actualRender } : {}),
  };
}

interface Accumulator {
  compared: number; kept: number; engaged: number; engagedKept: number;
  /** Corrections counted only where somebody engaged, so every column shares a denominator. */
  corrected: number; signed: number; absolute: number;
  /** Σ|actual − predicted| and Σ|actual − neutral| over engaged comparisons. */
  err: number; fromNeutral: number;
}

export function summarize(observations: readonly FeedbackObservation[]): FeedbackSummary {
  const stats = new Map<string, Accumulator>();
  let untouched = 0;

  for (const observation of observations) {
    let corrections = 0;
    for (const param of DEVELOP_PARAMS) {
      const predicted = observation.predicted[param.key];
      const current = observation.actual[param.key];
      if (predicted === undefined || current === undefined) continue;

      let s = stats.get(param.key);
      if (!s) {
        s = { compared: 0, kept: 0, engaged: 0, engagedKept: 0, corrected: 0, signed: 0, absolute: 0, err: 0, fromNeutral: 0 };
        stats.set(param.key, s);
      }
      s.compared++;

      // Did either side actually move this slider off its neutral? Agreeing to
      // leave it alone is not a prediction — see ParamFeedback.engaged.
      const neutral = neutralOf(param);
      const tol = tolerance(param.key);
      const engaged = Math.abs(predicted - neutral) > tol || Math.abs(current - neutral) > tol;
      if (engaged) {
        s.engaged++;
        s.err += Math.abs(current - predicted);
        s.fromNeutral += Math.abs(current - neutral);
      }
      const delta = current - predicted;
      if (Math.abs(delta) <= tol) {
        s.kept++;
        if (engaged) s.engagedKept++;
      } else {
        corrections++;
        if (engaged) {
          s.corrected++;
          s.signed += delta;
          s.absolute += Math.abs(delta);
        }
      }
    }
    if (corrections === 0) untouched++;
  }

  const params: ParamFeedback[] = DEVELOP_PARAMS.flatMap((param) => {
    const s = stats.get(param.key);
    if (!s || s.compared === 0) return [];
    return [{
      key: param.key,
      group: param.group,
      compared: s.compared,
      kept: s.kept,
      engaged: s.engaged,
      engagedKept: s.engagedKept,
      bias: s.corrected > 0 ? s.signed / s.corrected : 0,
      spread: s.corrected > 0 ? s.absolute / s.corrected : 0,
      journey: s.fromNeutral > 1e-9 ? 1 - s.err / s.fromNeutral : 0,
    }];
  });

  const totals = params.reduce(
    (a, r) => ({
      compared: a.compared + r.compared, kept: a.kept + r.kept,
      engaged: a.engaged + r.engaged, engagedKept: a.engagedKept + r.engagedKept,
    }),
    { compared: 0, kept: 0, engaged: 0, engagedKept: 0 },
  );

  return {
    images: observations.length,
    untouched,
    acceptance: totals.compared > 0 ? totals.kept / totals.compared : 0,
    engagedAcceptance: totals.engaged > 0 ? totals.engagedKept / totals.engaged : 0,
    params,
  };
}

/**
 * Comparisons on which a parameter is above the level of gossip.
 *
 * A per-parameter rate over a handful of images is noise — at six samples the
 * standard error on "kept 17%" is fifteen points — so a floor belongs here. It
 * used to be a flat 20, which is a defensible number for a catalog and an
 * impossible one for a shoot: on ten photographs no parameter can reach it, so
 * the table was unconditionally empty and the honest answer ("your set is too
 * small to break down") arrived disguised as a broken command.
 *
 * So: never fewer than three, never more than a quarter of the pool, and never
 * more than the 20 that a large pool can afford anyway. The rows a small pool
 * unlocks this way are fragile, and the report marks them as such rather than
 * pretending the floor made them solid.
 */
export const RELIABLE_SAMPLE = 20;
export function minMovedFloor(images: number): number {
  return Math.max(3, Math.min(RELIABLE_SAMPLE, Math.ceil(images / 4)));
}
