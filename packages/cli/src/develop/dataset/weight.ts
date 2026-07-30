/**
 * How much a corrected photograph counts when the model is refitted.
 *
 * A shoot you have already developed is not ordinary training data. Every frame
 * in it carries a note the catalog cannot: *this is what the model proposed, and
 * this is what you did about it*. Frames where you changed almost nothing and
 * frames you rebuilt from the ground up are worth very different amounts, and
 * training on both as if they were equal throws that away.
 *
 * So the weight is the size of the correction, normalized:
 *
 *     z_i      = mean over parameters of |actual − predicted| / spread(parameter)
 *     weight_i = clamp(z_i / median(z), min, max)
 *
 * A frame you corrected by a typical amount weighs 1 — exactly as much as an
 * ordinary catalog edit. Twice the usual correction weighs 2. Almost none weighs
 * the floor.
 *
 * **This is also the answer to the anchoring objection**, and the reason
 * weighting is not merely a refinement here. Editing *from* the prediction
 * contaminates the target: a frame you accepted wholesale is largely the model's
 * own output coming back as ground truth, which is how a model taught on its own
 * predictions collapses onto its own habits. Those are precisely the frames with
 * the smallest correction — so weighting by correction size down-weights the
 * contaminated samples automatically, without needing to identify them. The
 * frames that dominate the fit are the ones where you overruled the model, which
 * are the least anchored and the most informative at once.
 *
 * Normalizing by the *median* correction rather than by an absolute scale keeps
 * this honest as the model improves: when the predictions get better, every
 * correction shrinks, and an absolute scale would quietly stop weighting
 * anything. The question is always "large compared to what you usually change",
 * never "large in slider units".
 */
import { DEVELOP_PARAMS, withCurveTargets, type DevelopParam } from '../develop/schema.js';
import type { DevelopExportResult } from '../types.js';
import type { Prediction } from '../predict.js';

export const DEFAULT_MIN_WEIGHT = 0.25;
export const DEFAULT_MAX_WEIGHT = 3;

export interface WeightedRecord {
  file: string;
  /** Normalized correction size: 1 is a typical amount for this shoot. */
  z: number;
  weight: number;
  /** Parameters that were compared at all. */
  compared: number;
}

export interface WeightingResult {
  records: WeightedRecord[];
  /** Correction size the weights are measured against, in normalized units. */
  medianZ: number;
  /** Files with no prediction to compare against — left at weight 1. */
  unmatched: string[];
}

/**
 * Per-parameter spread across the catalog, used to make corrections comparable.
 *
 * Ten points of Contrast and ten points of Tint are not the same amount of
 * disagreement. Dividing by how much each parameter actually varies across the
 * photographer's own work puts every correction on one scale — the same trick the
 * trainer uses when it standardizes its targets, for the same reason.
 */
export function paramSpread(records: readonly DevelopExportResult[]): Map<string, number> {
  const spread = new Map<string, number>();
  for (const param of DEVELOP_PARAMS) {
    const values: number[] = [];
    for (const r of records) {
      const develop = withCurveTargets(r.develop, r.curve);
      const v = develop[param.key];
      if (v !== undefined && Number.isFinite(v)) values.push(v);
    }
    if (values.length < 2) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);
    // A parameter nobody ever moves has no scale to speak of, and dividing by an
    // epsilon would turn its rounding noise into the loudest signal in the set.
    if (sd > 1e-6) spread.set(param.key, sd);
  }
  return spread;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const byKey = new Map<string, DevelopParam>(DEVELOP_PARAMS.map((p) => [p.key, p]));

export function weighByCorrection(
  records: readonly DevelopExportResult[],
  predictions: readonly Prediction[],
  spread: Map<string, number>,
  options: { minWeight?: number; maxWeight?: number } = {},
): WeightingResult {
  const minWeight = options.minWeight ?? DEFAULT_MIN_WEIGHT;
  const maxWeight = options.maxWeight ?? DEFAULT_MAX_WEIGHT;
  const predicted = new Map(predictions.map((p) => [p.file, p]));

  const scored: { file: string; z: number; compared: number }[] = [];
  const unmatched: string[] = [];

  for (const record of records) {
    const prediction = predicted.get(record.file);
    if (!prediction) {
      unmatched.push(record.file);
      continue;
    }
    const actual = withCurveTargets(record.develop, record.curve);
    let total = 0;
    let compared = 0;
    for (const [key, proposed] of Object.entries(prediction.develop)) {
      const scale = spread.get(key);
      const param = byKey.get(key);
      if (scale === undefined || param === undefined) continue;
      // A slider absent from the edit sits at its neutral, which is a real
      // decision — the same convention the journal records.
      const now = actual[key] ?? (param.ref === 'const' ? (param.refConst ?? 0) : 0);
      if (!Number.isFinite(now)) continue;
      total += Math.abs(now - proposed) / scale;
      compared++;
    }
    scored.push({ file: record.file, z: compared > 0 ? total / compared : 0, compared });
  }

  const medianZ = median(scored.filter((s) => s.compared > 0).map((s) => s.z));
  const weightOf = (z: number): number =>
    medianZ > 1e-9 ? Math.min(maxWeight, Math.max(minWeight, z / medianZ)) : 1;

  return {
    records: scored.map((s) => ({ file: s.file, z: s.z, weight: weightOf(s.z), compared: s.compared })),
    medianZ,
    unmatched,
  };
}
