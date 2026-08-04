/**
 * Which photographs to put on the review screen.
 *
 * The obvious choice — a handful at random — shows nothing. Measured on a real
 * catalog, a correctly exposed frame renders within 0.02 EV of itself whether the
 * model is at its most timid or its boldest, because it sits inside the anchors'
 * dead zone and no correction applies. A reviewer shown five of those would
 * report that the sliders do nothing.
 *
 * So frames are picked for **distance from the dead zone**, one group per slider
 * family: the frames where that family's correction is largest are the only ones
 * whose appearance carries information about its intensity. One frame near the
 * middle rides along as the control — it should look the same at every setting,
 * and if it does not, something is wrong that the reviewer should see.
 */
import type { DevelopExportResult } from '../types.js';
import { anchorValue, type AnchorModel } from '../train/anchor.js';

/**
 * One control per anchored parameter, in histogram order.
 *
 * Not grouped. Grouping was the first design and it was wrong twice over.
 *
 * Conceptually: `Whites` is where the histogram is allowed to clip and
 * `Highlights` is the recoverable region below it, exactly as `Blacks` is the
 * black point and `Shadows` the region above it. They are different decisions
 * about different parts of the histogram, and a photographer sets them
 * separately because they *are* separate.
 *
 * Practically: a grouped control scales every parameter in it by the same
 * factor, so members whose fitted gains have opposite signs cancel. Highlights
 * and Whites did precisely that on the reference catalog — −32.7 against +177 —
 * and the rendered frame moved 0.9% across the whole slider. The control was
 * inert and looked broken.
 *
 * Offering one per parameter costs nothing, because the reviewability test drops
 * whatever does not visibly move. A short screen is the *result* of that test,
 * not an assumption baked in here.
 */
export type FamilyId = string;

/** Which control scales a given anchored parameter — now one to one. */
export const familyOf = (param: string): FamilyId | undefined =>
  FAMILIES.some((f) => f.id === param) ? param : undefined;

export const FAMILIES = [
  { id: 'Exposure2012', label: 'Exposure', params: ['Exposure2012'], shownAs: 'Exposure2012', unit: ' EV', decimals: 2 },
  { id: 'Whites2012', label: 'Whites', params: ['Whites2012'], shownAs: 'Whites2012', unit: '', decimals: 0 },
  { id: 'Highlights2012', label: 'Highlights', params: ['Highlights2012'], shownAs: 'Highlights2012', unit: '', decimals: 0 },
  { id: 'Contrast2012', label: 'Contrast', params: ['Contrast2012'], shownAs: 'Contrast2012', unit: '', decimals: 0 },
  { id: 'Shadows2012', label: 'Shadows', params: ['Shadows2012'], shownAs: 'Shadows2012', unit: '', decimals: 0 },
  { id: 'Blacks2012', label: 'Blacks', params: ['Blacks2012'], shownAs: 'Blacks2012', unit: '', decimals: 0 },
  { id: 'Dehaze', label: 'Dehaze', params: ['Dehaze'], shownAs: 'Dehaze', unit: '', decimals: 0 },
  { id: 'Texture', label: 'Texture', params: ['Texture'], shownAs: 'Texture', unit: '', decimals: 0 },
  { id: 'Clarity2012', label: 'Clarity', params: ['Clarity2012'], shownAs: 'Clarity2012', unit: '', decimals: 0 },
  { id: 'Vibrance', label: 'Vibrance', params: ['Vibrance'], shownAs: 'Vibrance', unit: '', decimals: 0 },
  { id: 'Saturation', label: 'Saturation', params: ['Saturation'], shownAs: 'Saturation', unit: '', decimals: 0 },
] as const;

export interface Candidate {
  record: DevelopExportResult;
  /** Which family this frame was chosen to demonstrate; absent for the control. */
  family?: FamilyId;
  /** How far outside the dead zone it sits, in the anchor's own units. */
  excess: number;
}

/**
 * Pick up to `limit` frames: the most extreme for each family, plus one control.
 *
 * Only frames whose RAW is still on disk are eligible — the caller filters those
 * — because the preview has to be rendered from the original, not from anything
 * the dataset kept.
 */
export function selectFrames(
  records: readonly DevelopExportResult[],
  anchors: Record<string, AnchorModel>,
  limit = 5,
): Candidate[] {
  const chosen: Candidate[] = [];
  const taken = new Set<string>();

  for (const family of FAMILIES) {
    const models = family.params.map((p) => anchors[p]).filter((m): m is AnchorModel => m !== undefined);
    if (models.length === 0) continue;
    let best: Candidate | undefined;
    for (const record of records) {
      if (taken.has(record.file) || !record.features?.length) continue;
      // The largest correction this family makes **on the side the anchor exists
      // for** — above the dead zone, where the scene carries an excess.
      //
      // Two earlier rankings were wrong in instructive ways. By distance from
      // centre, the darkest frame in the catalog won for Exposure and then
      // demonstrated nothing, since the gain below the dead zone is +0.08 against
      // −1.41 above. By absolute correction, Highlights landed on a frame *under*
      // the zone where the anchor moves the slider from −58 to +1 — a real and
      // large correction, in the direction of *undoing* recovery, which makes the
      // control read backwards to anyone calibrating highlight recovery with it.
      //
      // The excess side is the one the control is named after and the one a
      // photographer can judge: a blown frame being pulled back.
      let excess = 0;
      for (const m of models) {
        const x = anchorValue(m, record.features);
        if (x === null) continue;
        const gap = x - m.xbar - (m.deadband ?? 0);
        if (gap <= 0) continue;
        // Scaled by the parameter's own range so families in stops and families
        // in ±100 slider units can be compared at all.
        const range = Math.max(1, Math.abs(m.gain) * ((m.deadband ?? 0) || 1));
        excess = Math.max(excess, Math.abs(m.gain * gap) / range);
      }
      if (excess > 0 && (best === undefined || excess > best.excess)) {
        best = { record, family: family.id, excess };
      }
    }
    if (best) {
      chosen.push(best);
      taken.add(best.record.file);
    }
  }

  // The control: whichever frame sits closest to every anchor's centre. It is
  // the one that must *not* change, and seeing it hold still is what tells the
  // reviewer the sliders are doing what they claim.
  let control: Candidate | undefined;
  for (const record of records) {
    if (taken.has(record.file) || !record.features?.length) continue;
    let worst = 0;
    for (const m of Object.values(anchors)) {
      const x = anchorValue(m, record.features);
      if (x === null) continue;
      worst = Math.max(worst, Math.abs(x - m.xbar) / ((m.deadband ?? 0) || 1));
    }
    if (control === undefined || worst < control.excess) control = { record, excess: worst };
  }
  if (control) chosen.push(control);

  return chosen.slice(0, limit);
}
