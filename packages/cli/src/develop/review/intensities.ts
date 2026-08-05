/**
 * Scaling a fitted profile by what the reviewer chose.
 *
 * Separate from the server so the ramp builder can use it without importing the
 * screen, and so the two commands that apply a saved answer (`train`,
 * `calibrate`) depend on this and nothing else.
 *
 * **Intensities are per treatment.** A profile fits colour and black-and-white
 * as separate branches with separate anchors, and one multiplier across both
 * says that a decision taken looking at colour photographs also holds for
 * monochrome ones — which is not a claim anybody made. On a real catalog the
 * frames on screen came out colour every time simply because there are more of
 * them, so the black-and-white anchors were being scaled by a number nobody had
 * ever seen applied to a black-and-white photograph. That branch is also the one
 * the model predicts worst, so it is the one that most needs a human to look.
 */
import { familyOf } from './select.js';
import type { DevelopProfile } from '../types.js';

/**
 * What the reviewer chose, keyed by `treatment:parameter`. 1 leaves the fitted
 * gain alone.
 */
export type Intensities = Record<string, number>;

/** The key one control is stored under. */
export const intensityKey = (treatment: string, family: string): string => `${treatment}:${family}`;

/** Split a key back into its treatment and parameter, for display. */
export function splitKey(key: string): { treatment: string; family: string } {
  const at = key.indexOf(':');
  return at < 0 ? { treatment: 'color', family: key } : { treatment: key.slice(0, at), family: key.slice(at + 1) };
}

/**
 * Scale every anchor of every branch by its control's multiplier, in place.
 *
 * Applied to the profile *after* it is fitted and scored, so the skills stored
 * on each anchor keep describing the gain as measured. The multiplier is a taste
 * decision taken on top of the evidence, not a correction to it.
 */
export function applyIntensities(profile: DevelopProfile, intensities: Intensities): void {
  for (const [treatment, branch] of Object.entries(profile.branches)) {
    if (!branch?.anchors) continue;
    for (const [key, anchor] of Object.entries(branch.anchors)) {
      const family = familyOf(key);
      const scale = family ? intensities[intensityKey(treatment, family)] : undefined;
      if (scale === undefined || scale === 1) continue;
      anchor.gain *= scale;
      if (anchor.gainBelow !== undefined) anchor.gainBelow *= scale;
    }
  }
}

/**
 * Run `fn` against a profile scaled by `intensities`, then put it back.
 *
 * Building a ramp means predicting the same frame at sixty different
 * intensities, and deep-cloning a fitted profile — PCA bases and all — sixty
 * times per control is most of a second of copying to produce a few hundred
 * numbers. Only the anchor gains are touched, so saving and restoring exactly
 * those is both cheaper and narrower.
 *
 * `fn` must be synchronous. Nothing may observe the profile while it is scaled:
 * a half-finished slider drag must never leave a scaled anchor behind in the
 * object that eventually gets written out.
 */
export function withIntensities<T>(profile: DevelopProfile, intensities: Intensities, fn: () => T): T {
  const saved: { anchor: { gain: number; gainBelow?: number }; gain: number; gainBelow?: number }[] = [];
  for (const [treatment, branch] of Object.entries(profile.branches)) {
    for (const [key, anchor] of Object.entries(branch?.anchors ?? {})) {
      const family = familyOf(key);
      const scale = family ? intensities[intensityKey(treatment, family)] : undefined;
      if (scale === undefined || scale === 1) continue;
      saved.push({ anchor, gain: anchor.gain, gainBelow: anchor.gainBelow });
    }
  }
  applyIntensities(profile, intensities);
  try {
    return fn();
  } finally {
    for (const s of saved) {
      s.anchor.gain = s.gain;
      if (s.gainBelow !== undefined) s.anchor.gainBelow = s.gainBelow;
    }
  }
}

/**
 * What was chosen, in one line — with the treatment named, because "Exposure
 * 2.20×" is a different decision on colour than on black-and-white and a log
 * that cannot tell them apart cannot be checked later.
 */
export function describeIntensities(intensities: Intensities): string {
  return Object.entries(intensities)
    .map(([key, value]) => {
      const { treatment, family } = splitKey(key);
      return `${family} ${value.toFixed(2)}× (${treatment === 'bw' ? 'b&w' : treatment})`;
    })
    .join(', ');
}

/** Every control the profile has an anchor for, with 1 as the starting point. */
export function activeFamilies(profile: DevelopProfile): Intensities {
  const out: Intensities = {};
  for (const [treatment, branch] of Object.entries(profile.branches)) {
    for (const key of Object.keys(branch?.anchors ?? {})) {
      const family = familyOf(key);
      if (family) out[intensityKey(treatment, family)] = 1;
    }
  }
  return out;
}
