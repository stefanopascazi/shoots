/**
 * Intent thresholds in the photographer's own terms.
 *
 * "Preserve highlights" has to mean *where this photographer keeps highlights
 * when they protect them*, not a number chosen in the abstract — and it has to
 * be measured in the same rendering the intents are judged in. Both come from
 * one place: the photographer's finished edits, rendered by the tone model the
 * solver uses. Whatever that model gets wrong about Lightroom's rendering, it
 * gets wrong identically on both sides, so it cancels.
 */
import { LOOK_PERCENTILES } from '../look/tone.js';

/** The bounds intents use, in display values 0..1. */
export interface IntentThresholds {
  /** preserve-highlights: the 99th percentile at most this. */
  highlightCap: number;
  /** open-shadows: the 5th percentile at least this. */
  shadowFloor: number;
  /** keep-shadows-deep: the 5th percentile at most this. */
  deepShadowCap: number;
  /** expose-correctly: the median within [midLow, midHigh]. */
  midLow: number;
  midHigh: number;
}

/** Used until `develop intents calibrate` has measured the photographer. */
export const DEFAULT_THRESHOLDS: IntentThresholds = {
  highlightCap: 0.93,
  shadowFloor: 0.1,
  deepShadowCap: 0.045,
  midLow: 0.38,
  midHigh: 0.55,
};

export interface IntentCalibration {
  type: 'develop-intents';
  at: string;
  /** Edited frames and shoots the thresholds were read from. */
  frames: number;
  shoots: number;
  thresholds: IntentThresholds;
  /** Default intent strength, 0..1, set by `develop intents set --strength` once tuned by eye. */
  strength?: number;
}

const at = (p: number): number => LOOK_PERCENTILES.indexOf(p as (typeof LOOK_PERCENTILES)[number]);

function quantile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  return s[lo]! + (s[Math.min(s.length - 1, lo + 1)]! - s[lo]!) * (pos - lo);
}

/** Fewer finished looks than this and the defaults stand: a quantile of a handful is noise. */
export const MIN_LOOKS = 20;

/**
 * Thresholds from the looks of the photographer's finished edits.
 *
 * Each bound is where the photographer's own work sits:
 *  - highlight cap: their *typical* top end (median p99). Preserving highlights
 *    means no brighter than they usually allow — so a frame already within their
 *    habit is left alone, and only one at risk is pulled back. Their most
 *    contained fifth was tried first and moved every frame by −50 Whites.
 *  - shadow floor: how open their shadows are in their more open third (70th
 *    percentile of p5); the deep-shadow cap, how deep in their deeper third (30th).
 *  - exposure band: the middle half of their medians.
 * An intent then asks for "your highlights", not a number from a manual.
 */
export function thresholdsFromLooks(looks: readonly (readonly number[])[]): IntentThresholds {
  if (looks.length < MIN_LOOKS) return DEFAULT_THRESHOLDS;
  const p99 = looks.map((l) => l[at(0.99)]!);
  const p05 = looks.map((l) => l[at(0.05)]!);
  const mid = looks.map((l) => l[at(0.5)]!);
  const deepShadowCap = quantile(p05, 0.3);
  const shadowFloor = quantile(p05, 0.7);
  return {
    // Never at or above white: a cap of 1 would let every blown frame through.
    highlightCap: Math.min(quantile(p99, 0.5), 0.98),
    // The two shadow bounds must not cross, or both intents would ask for the same frame.
    shadowFloor: Math.max(shadowFloor, deepShadowCap + 0.01),
    deepShadowCap,
    midLow: quantile(mid, 0.25),
    midHigh: Math.max(quantile(mid, 0.75), quantile(mid, 0.25) + 0.02),
  };
}
