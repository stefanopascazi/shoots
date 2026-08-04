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
 * Slider families, the anchored parameters each scales, and the one parameter
 * whose value the slider is *labelled* with.
 *
 * The label matters more than it sounds. A multiplier on a fitted gain is an
 * implementation detail — "×2.2" tells a photographer nothing about what will
 * land in Lightroom. The slider therefore reads in the units of `shownAs`:
 * −1.4 EV, −72 highlights. The multiplier is derived from wherever it is left.
 */
export const FAMILIES = [
  { id: 'exposure', label: 'Exposure', params: ['Exposure2012'], shownAs: 'Exposure2012', unit: ' EV', decimals: 2 },
  { id: 'highlights', label: 'Highlights', params: ['Highlights2012', 'Whites2012'], shownAs: 'Highlights2012', unit: '', decimals: 0 },
  { id: 'presence', label: 'Dehaze', params: ['Dehaze', 'Texture', 'Clarity2012'], shownAs: 'Dehaze', unit: '', decimals: 0 },
  { id: 'colour', label: 'Vibrance', params: ['Vibrance', 'Saturation'], shownAs: 'Vibrance', unit: '', decimals: 0 },
] as const;

export type FamilyId = (typeof FAMILIES)[number]['id'];

export const familyOf = (param: string): FamilyId | undefined =>
  FAMILIES.find((f) => (f.params as readonly string[]).includes(param))?.id;

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
