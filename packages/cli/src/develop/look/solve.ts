/**
 * Tone controls that put a frame on a target look.
 *
 * The inverse of `lookOf`: given where the photographer's look puts the
 * histogram, find the six controls that land this frame there. A penalty pulls
 * every control toward a prior, so a control the target does not need is left
 * where the photographer usually leaves it instead of being spent to shave a
 * code value.
 */
import { lookDistance, lookOf, NEUTRAL_TONE, type LumaHistogram, type Tone } from './tone.js';

const KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] as const;
/** Search bounds: Exposure in stops, the rest in shader units. */
const LIMIT: Record<(typeof KEYS)[number], number> = {
  exposure: 3,
  contrast: 1,
  highlights: 1,
  shadows: 1,
  whites: 1,
  blacks: 1,
};

export interface SolveOptions {
  /** Controls fall back toward this when the target does not ask for them. */
  prior?: Tone;
  /** Cost of one unit of control away from the prior, in squared code values. */
  stiffness?: number;
  /**
   * Weight per look percentile; 0 leaves that percentile free. Lets a target
   * say only what it means — "keep the highlights below 240" — without
   * pinning the rest of the histogram.
   */
  weights?: readonly number[];
}

/**
 * Compass search over the six controls.
 *
 * Deterministic and derivative-free: the objective has kinks (the shader's
 * clamps and smoothsteps), and 256 bins make each evaluation cheap enough that a
 * few thousand of them cost milliseconds.
 */
export function solveTone(h: LumaHistogram, target: readonly number[], opts: SolveOptions = {}): Tone {
  const prior = opts.prior ?? NEUTRAL_TONE;
  const stiffness = opts.stiffness ?? 4;
  const weights = opts.weights;
  const cost = (t: Tone): number => {
    const look = lookOf(h, t);
    let d2 = 0;
    if (weights) {
      for (let i = 0; i < look.length; i++) d2 += weights[i]! * ((look[i]! - target[i]!) * 255) ** 2;
    } else {
      d2 = lookDistance(look, target) ** 2;
    }
    let pen = 0;
    for (const k of KEYS) pen += ((t[k] - prior[k]) / LIMIT[k]) ** 2;
    return d2 + stiffness * pen;
  };
  // Exposure moves everything, so a local search started at the wrong
  // brightness lets the regional controls fake it and stops in a local minimum
  // (a darker frame "solved" with Blacks and Shadows). Every exposure on a
  // coarse grid gets its own rough solve; only the winner is refined.
  let best: Tone = { ...prior };
  let bestCost = cost(best);
  for (let e = -LIMIT.exposure; e <= LIMIT.exposure + 1e-9; e += 0.25) {
    const [t, c] = compass({ ...prior, exposure: e }, cost, 0.25, 0.03);
    if (c < bestCost) [best, bestCost] = [t, c];
  }
  return compass(best, cost, 0.03, 1e-3)[0];
}

/** Coordinate pattern search, halving the step from `from` down to `to`. */
function compass(start: Tone, cost: (t: Tone) => number, from: number, to: number): [Tone, number] {
  let best = start;
  let bestCost = cost(best);
  for (let step = from; step > to; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const k of KEYS) {
        for (const dir of [1, -1]) {
          const v = Math.min(LIMIT[k], Math.max(-LIMIT[k], best[k] + dir * step * LIMIT[k]));
          if (v === best[k]) continue;
          const cand = { ...best, [k]: v };
          const c = cost(cand);
          if (c < bestCost) {
            best = cand;
            bestCost = c;
            improved = true;
          }
        }
      }
    }
  }
  return [best, bestCost];
}
