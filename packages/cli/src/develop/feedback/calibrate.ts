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
import { sessionKey } from '../develop/session.js';
import { tolerance } from './stats.js';
import { isInSample, type FeedbackObservation } from './journal.js';

/** Correction shrunk toward zero before it is applied. See {@link estimateOffsets}. */
export const DEFAULT_SHRINK = 0.5;
/**
 * Shoots a parameter needs before an offset is estimated for it at all.
 *
 * Four, and not by taste: the direction test wants two sigma of a fair coin, and
 * three shoots agreeing unanimously only reach 3/√3 = 1.73. Anything below four
 * could never pass, so a lower floor would only promise evidence it cannot
 * deliver.
 */
export const DEFAULT_MIN_SHOOTS = 4;

export interface ParamOffset {
  key: string;
  /** Comparisons behind it — context only; the decision is made per shoot. */
  n: number;
  /** Shoots that had something to say about this parameter. */
  shoots: number;
  /** …of those, how many leaned up and down. */
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
  shoots: number;
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
 * Four decisions, and the first one is the one that matters:
 *
 *  - **One shoot is one vote, not one photograph.** A shoot is dozens or hundreds
 *    of near-identical frames edited by pasting settings across the take, so
 *    counting photographs counts a single styling decision as many independent
 *    ones. Measured on a simulated wedding — 400 frames pushed +6, against two
 *    smaller shoots pulling −5 and −6 — the per-photograph test reported 16 sigma
 *    of confidence and applied +3, in the direction two shoots out of three
 *    disagreed with. Per shoot the same evidence gives 0.6 sigma and applies
 *    nothing, which is the honest answer for three shoots. This is the same
 *    reasoning that makes the trainer hold out whole folders; calibration had no
 *    business ignoring it.
 *  - **Every comparison counts inside a shoot, not only the ones somebody moved.**
 *    The report quotes bias over engaged corrections, which answers "when you
 *    correct this, by how much". An offset is applied to *every* prediction, so
 *    within a shoot it is estimated over every prediction — a slider left at
 *    neutral on nine frames out of ten is nine votes for leaving it alone.
 *  - **Median at both levels.** Within a shoot it resists the one photograph
 *    edited from scratch rather than from our sidecar; across shoots it resists
 *    the one job that was nothing like the others. The tool reports MAE
 *    throughout, and the median is what minimizes it.
 *  - **A sign test, not a t-test.** Whether the shoots lean one way is exactly
 *    what a count of ups against downs answers, and it assumes nothing about a
 *    distribution that is heavy-tailed and clipped at both ends.
 */
export function estimateOffsets(
  observations: readonly FeedbackObservation[],
  treatment: Treatment,
  options: { shrink?: number; minShoots?: number } = {},
): CalibrationEstimate {
  const shrink = options.shrink ?? DEFAULT_SHRINK;
  const minShoots = options.minShoots ?? DEFAULT_MIN_SHOOTS;
  const pool = observations.filter((o) => o.treatment === treatment);
  const eligible = new Set(paramsForTreatment(treatment).map((p) => p.key));

  // The capture folder, the same unit the trainer holds out by. A photographer
  // organises by shoot, and a shoot is where settings get pasted around.
  const bySession = new Map<string, FeedbackObservation[]>();
  for (const o of pool) {
    const key = sessionKey(o.file);
    bySession.set(key, [...(bySession.get(key) ?? []), o]);
  }
  const sessions = [...bySession.values()];

  const params: ParamOffset[] = [];
  const offsets: Record<string, number> = {};

  for (const param of DEVELOP_PARAMS) {
    if (!eligible.has(param.key)) continue;
    const tol = tolerance(param.key);
    /** One entry per shoot: that shoot's correction for this parameter. */
    const votes: number[] = [];
    /** The same in slider units, for the direction test where the tolerance lives. */
    const votesRaw: number[] = [];
    let images = 0;

    for (const session of sessions) {
      const deltas: number[] = [];
      const raw: number[] = [];
      for (const o of session) {
        const predicted = o.predicted[param.key];
        const current = o.actual[param.key];
        if (predicted === undefined || current === undefined) continue;
        deltas.push(toCorrectionSpace(param, current) - toCorrectionSpace(param, predicted));
        raw.push(current - predicted);
      }
      if (deltas.length === 0) continue;
      images += deltas.length;
      votes.push(median(deltas));
      votesRaw.push(median(raw));
    }

    if (votes.length === 0) continue;
    const up = votesRaw.filter((d) => d > tol).length;
    const down = votesRaw.filter((d) => d < -tol).length;
    const decided = up + down;
    const sigma = decided > 0 ? Math.abs(up - down) / Math.sqrt(decided) : 0;
    const measured = median(votes);

    const row: ParamOffset = {
      key: param.key, n: images, shoots: votes.length, up, down, measured, offset: 0, sigma,
    };
    if (votes.length < minShoots) row.rejected = 'too-few';
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

  return { treatment, images: pool.length, shoots: sessions.length, offsets, params };
}

/**
 * Observations that can still measure a model's error.
 *
 * The bar is where the *prediction* came from, not where the photograph ended
 * up — see {@link isInSample}, which owns that decision and explains why reading
 * it any other way costs a catalog its calibration evidence.
 *
 * An earlier version of this excluded everything `learn` had touched, which
 * guarded against the wrong thing and broke the ordinary edit → correct → learn
 * cycle: after one pass there was nothing left to calibrate on, ever.
 */
export function heldOut(observations: readonly FeedbackObservation[]): FeedbackObservation[] {
  return observations.filter((o) => !isInSample(o));
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
