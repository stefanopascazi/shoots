/**
 * Scaling a fitted profile by what the reviewer chose.
 *
 * Separate from the server so the ramp builder can use it without importing the
 * screen, and so the two commands that apply a saved answer (`train`,
 * `calibrate`) depend on this and nothing else.
 */
import { familyOf } from './select.js';
import type { DevelopProfile } from '../types.js';

/** What the reviewer chose, per family. 1 leaves the fitted gain alone. */
export type Intensities = Record<string, number>;

/**
 * Scale every anchor of every branch by its family's multiplier, in place.
 *
 * Applied to the profile *after* it is fitted and scored, so the skills stored
 * on each anchor keep describing the gain as measured. The multiplier is a taste
 * decision taken on top of the evidence, not a correction to it.
 */
export function applyIntensities(profile: DevelopProfile, intensities: Intensities): void {
  for (const branch of Object.values(profile.branches)) {
    if (!branch?.anchors) continue;
    for (const [key, anchor] of Object.entries(branch.anchors)) {
      const family = familyOf(key);
      const scale = family ? intensities[family] : undefined;
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
  for (const branch of Object.values(profile.branches)) {
    for (const [key, anchor] of Object.entries(branch?.anchors ?? {})) {
      const family = familyOf(key);
      const scale = family ? intensities[family] : undefined;
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

/** Families that have at least one anchor to scale, with 1 as the starting point. */
export function activeFamilies(profile: DevelopProfile): Intensities {
  const out: Intensities = {};
  for (const branch of Object.values(profile.branches)) {
    for (const key of Object.keys(branch?.anchors ?? {})) {
      const family = familyOf(key);
      if (family) out[family] = 1;
    }
  }
  return out;
}
