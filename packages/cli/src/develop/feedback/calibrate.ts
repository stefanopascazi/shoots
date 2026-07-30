/**
 * Turning the journal into a correction the profile can carry.
 *
 * `feedback` measures where the predictions land; this decides what to do about
 * it. The narrow thing it does — and the narrowness is the point — is estimate a
 * **constant offset per parameter**: the amount this profile is reliably wrong
 * by, in the same direction, on every photograph.
 *
 * Why only that, when the journal holds enough to retrain on:
 *
 * The photographer edits *from* our sidecar. That makes every observation partly
 * a reaction to what we proposed rather than an independent opinion, and feeding
 * it back as ground truth teaches the model that its own output was correct. Do
 * that repeatedly and the predictions stop tracking the photographs and start
 * tracking themselves — the variance collapses and the profile converges on its
 * own habits. An offset is the one correction where that anchoring is *safe*:
 * a photographer who accepts a value they would have pushed further only makes
 * the measured offset smaller, so the estimate errs toward under-correcting,
 * and under-correcting a constant costs nothing but another round.
 *
 * Growing the catalog with the developed shoot is the other half of the idea and
 * is deliberately not here: it needs the frames' features, which the journal does
 * not store, and it is what `export` + `train` already do — on files the
 * photographer edited, not on files the photographer approved.
 */
import {
  DEVELOP_PARAMS,
  paramsForTreatment,
  type DevelopParam,
  type Treatment,
} from '../develop/schema.js';
import { tolerance } from './stats.js';
import type { FeedbackObservation } from './journal.js';

/** Correction shrunk toward zero before it is applied. See {@link estimateOffsets}. */
export const DEFAULT_SHRINK = 0.5;
/** Comparisons a parameter needs before an offset is estimated for it at all. */
export const DEFAULT_MIN_IMAGES = 10;

export interface ParamOffset {
  key: string;
  /** Comparisons behind it. */
  n: number;
  /** …of those, how many the photographer moved up and down. */
  up: number;
  down: number;
  /** The measured correction, in the parameter's own correction space. */
  measured: number;
  /** …after shrinkage: what actually gets applied. */
  offset: number;
  /** How lopsided the direction is, in standard deviations of a fair coin. */
  sigma: number;
  /** Why an offset was not taken, when it was not. */
  rejected?: 'too-few' | 'no-direction';
}

export interface CalibrationEstimate {
  treatment: Treatment;
  images: number;
  /** Offsets that passed both gates, keyed by param. */
  offsets: Record<string, number>;
  /** Every parameter considered, including the rejected ones — this is the report. */
  params: ParamOffset[];
}

/**
 * The space a correction is a *constant* in.
 *
 * For a plain slider that is the difference: "always +8 contrast". For white
 * balance it is not. Temperature is anchored to the as-shot value and lives in
 * log-Kelvin, so "+500 K" means one thing under tungsten and another in daylight
 * — the constant a photographer actually applies there is a ratio. Getting this
 * wrong would put the biggest accuracy lever in the schema on the wrong scale.
 */
function toCorrectionSpace(param: DevelopParam, value: number): number {
  return param.transform === 'logK' ? Math.log(Math.max(value, 1)) : value;
}

export function applyOffset(param: DevelopParam, value: number, offset: number): number {
  const moved = param.transform === 'logK' ? Math.max(value, 1) * Math.exp(offset) : value + offset;
  return Math.min(param.absMax, Math.max(param.absMin, moved));
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * The offsets one branch's predictions should carry.
 *
 * Three decisions worth stating, because none of them is the obvious one:
 *
 *  - **Every comparison counts, not only the ones somebody moved.** The report
 *    quotes bias over engaged corrections, which answers "when you correct this,
 *    by how much". An offset is applied to *every* prediction, so it has to be
 *    estimated over every prediction — a slider left at neutral on nine images
 *    out of ten is nine votes for leaving the offset alone, and dropping them
 *    would push the whole shoot off neutral to chase one photograph.
 *  - **Median, not mean.** The tool reports MAE throughout, and the median is
 *    what minimizes it. It also survives the failure this cannot detect: one
 *    photograph edited from scratch instead of from our sidecar is an outlier,
 *    and an outlier moves a mean and not a median.
 *  - **A sign test, not a t-test.** The question is whether the corrections lean
 *    one way, which is exactly what the count of ups against downs answers, and
 *    it assumes nothing about a distribution that is heavy-tailed and clipped at
 *    both ends. Two sigma of a fair coin is the bar.
 */
export function estimateOffsets(
  observations: readonly FeedbackObservation[],
  treatment: Treatment,
  options: { shrink?: number; minImages?: number } = {},
): CalibrationEstimate {
  const shrink = options.shrink ?? DEFAULT_SHRINK;
  const minImages = options.minImages ?? DEFAULT_MIN_IMAGES;
  const pool = observations.filter((o) => o.treatment === treatment);
  const eligible = new Set(paramsForTreatment(treatment).map((p) => p.key));

  const params: ParamOffset[] = [];
  const offsets: Record<string, number> = {};

  for (const param of DEVELOP_PARAMS) {
    if (!eligible.has(param.key)) continue;
    const deltas: number[] = [];
    let up = 0;
    let down = 0;
    const tol = tolerance(param.key);

    for (const o of pool) {
      const predicted = o.predicted[param.key];
      const current = o.actual[param.key];
      if (predicted === undefined || current === undefined) continue;
      deltas.push(toCorrectionSpace(param, current) - toCorrectionSpace(param, predicted));
      // The direction test stays in slider units, where the tolerance is defined:
      // it asks "did they move it", not "by how much in log space".
      if (current - predicted > tol) up++;
      else if (predicted - current > tol) down++;
    }

    if (deltas.length === 0) continue;
    const decided = up + down;
    const sigma = decided > 0 ? Math.abs(up - down) / Math.sqrt(decided) : 0;
    const measured = median(deltas);

    const row: ParamOffset = {
      key: param.key, n: deltas.length, up, down, measured, offset: 0, sigma,
    };
    if (deltas.length < minImages) row.rejected = 'too-few';
    else if (sigma < 2) row.rejected = 'no-direction';
    else {
      // Shrunk on purpose. The measured offset is the best guess under anchoring
      // and noise, not a number to be trusted whole: half of it is a step that
      // cannot overshoot, and calibrating again after the next shoot takes half
      // of what is left. It converges; overshooting does not.
      row.offset = measured * shrink;
      if (Math.abs(row.offset) > 1e-9) offsets[param.key] = row.offset;
    }
    params.push(row);
  }

  return { treatment, images: pool.length, offsets, params };
}

/**
 * Observations whose rendering still matches the one `predict` wrote.
 *
 * Not proof the sidecar was imported — a photographer may change the base
 * profile deliberately — but a file carrying a *different* rendering was
 * developed from something other than what we handed it, and its "correction"
 * is measured against a different starting point than the one we predicted for.
 */
export function fromOurSidecar(observations: readonly FeedbackObservation[]): FeedbackObservation[] {
  return observations.filter((o) => o.predictedRender !== undefined && o.predictedRender === o.actualRender);
}

/** Observations that can answer the question at all. */
export function renderKnown(observations: readonly FeedbackObservation[]): FeedbackObservation[] {
  return observations.filter((o) => o.predictedRender !== undefined && o.actualRender !== undefined);
}
