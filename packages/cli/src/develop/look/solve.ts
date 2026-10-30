/**
 * Tone controls that put a frame on a target look.
 *
 * The inverse of `lookOf`: given where the photographer's look puts the
 * histogram, find the six controls that land this frame there. A penalty pulls
 * every control toward a prior, so a control the target does not need is left
 * where the photographer usually leaves it instead of being spent to shave a
 * code value.
 */
import { LOOK_PERCENTILES, lookDistance, lookOf, NEUTRAL_TONE, type LumaHistogram, type Tone } from './tone.js';

const KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] as const;
export type ToneControl = (typeof KEYS)[number];
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
    return d2 + stiffness * penalty(t, prior);
  };
  return minimise(cost, prior);
}

/**
 * A bound on the look: one display percentile (its index in LOOK_PERCENTILES),
 * or the spread between the 10th and 90th — the contrast a photographer sees.
 */
export interface LookConstraint {
  at: number | 'spread';
  /** A named region's histogram instead of the whole frame's (see meetConstraints' `regions`). */
  region?: string;
  min?: number;
  max?: number;
}

const P10 = LOOK_PERCENTILES.indexOf(0.1);
const P90 = LOOK_PERCENTILES.indexOf(0.9);

/** The value a constraint bounds, read off a look. */
export function constrained(look: readonly number[], at: LookConstraint['at']): number {
  return at === 'spread' ? look[P90]! - look[P10]! : look[at]!;
}

/**
 * How far a look is outside its bounds, in squared code values (0 when inside).
 * A constraint on a region reads that region's look from `regionLooks`, and is
 * skipped when the region has none.
 */
export function violation(
  look: readonly number[],
  constraints: readonly LookConstraint[],
  regionLooks: Readonly<Record<string, readonly number[]>> = {},
): number {
  let v = 0;
  for (const c of constraints) {
    const source = c.region ? regionLooks[c.region] : look;
    if (!source) continue;
    const x = constrained(source, c.at);
    if (c.max !== undefined && x > c.max) v += ((x - c.max) * 255) ** 2;
    if (c.min !== undefined && x < c.min) v += ((c.min - x) * 255) ** 2;
  }
  return v;
}

/**
 * The controls nearest the prior that keep the look inside its bounds.
 *
 * Inequalities, not targets: a bound already met costs nothing, so the prior —
 * the photographer's own prediction — comes back untouched unless a bound asks
 * for a change, and then only as much change as that bound needs.
 *
 * `free` names the controls allowed to move; the rest stay at the prior. Left
 * open, the cheapest route to a bound is often one no photographer would take —
 * "open the shadows" met by raising Exposure and cutting Contrast, with Shadows
 * itself going down.
 */
export function meetConstraints(
  h: LumaHistogram,
  constraints: readonly LookConstraint[],
  prior: Tone,
  free: readonly ToneControl[] = KEYS,
  stiffness = 25,
  regions: Readonly<Record<string, LumaHistogram>> = {},
): Tone {
  const looks = (t: Tone): Record<string, number[]> =>
    Object.fromEntries(Object.entries(regions).map(([k, rh]) => [k, lookOf(rh, t)]));
  if (!constraints.length || !free.length || violation(lookOf(h, prior), constraints, looks(prior)) === 0) return prior;
  // A full-range slider move costs as much as a 5-code-value miss: bounds win,
  // but a bound that cannot be met does not drag every slider to its end stop.
  const cost = (t: Tone): number => violation(lookOf(h, t), constraints, looks(t)) + stiffness * penalty(t, prior);
  return minimise(cost, prior, free);
}

const penalty = (t: Tone, prior: Tone): number => {
  let pen = 0;
  for (const k of KEYS) pen += ((t[k] - prior[k]) / LIMIT[k]) ** 2;
  return pen;
};

function minimise(cost: (t: Tone) => number, prior: Tone, free: readonly ToneControl[] = KEYS): Tone {
  // A local search alone stalls in two places: started at the wrong exposure,
  // the regional controls fake brightness and stop in a local minimum (a darker
  // frame "solved" with Blacks and Shadows); and on a clipped plateau, where a
  // small step changes nothing because the pixels are still past white. So
  // every free control is first swept on a coarse grid from the prior, each
  // point gets a rough solve, and only the winner is refined.
  let best: Tone = { ...prior };
  let bestCost = cost(best);
  for (const k of free) {
    for (let i = -4; i <= 4; i++) {
      const v = (i / 4) * LIMIT[k];
      if (v === prior[k]) continue;
      const [t, c] = compass({ ...prior, [k]: v }, cost, 0.25, 0.03, free);
      if (c < bestCost) [best, bestCost] = [t, c];
    }
  }
  return compass(best, cost, 0.03, 1e-3, free)[0];
}

/** Coordinate pattern search, halving the step from `from` down to `to`. */
function compass(start: Tone, cost: (t: Tone) => number, from: number, to: number, free: readonly ToneControl[] = KEYS): [Tone, number] {
  let best = start;
  let bestCost = cost(best);
  for (let step = from; step > to; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const k of free) {
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
