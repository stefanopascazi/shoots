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

/** Slider families, and the anchored parameters each one scales. */
export const FAMILIES = [
  { id: 'exposure', label: 'Exposure', params: ['Exposure2012'] },
  { id: 'highlights', label: 'Highlight recovery', params: ['Highlights2012', 'Whites2012'] },
  { id: 'presence', label: 'Presence', params: ['Dehaze', 'Texture', 'Clarity2012'] },
  { id: 'colour', label: 'Colour', params: ['Vibrance', 'Saturation'] },
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
      // The largest *correction* this family's anchors produce on this frame,
      // not the largest distance from centre. The two differ whenever a gain is
      // asymmetric, and Exposure's is extreme: −1.41 above the dead zone against
      // +0.08 below it, because this photographer pulls overexposure back hard
      // and leaves underexposure alone. Ranked by distance, the darkest frame in
      // the catalog wins and then demonstrates nothing, since its gain is ~0.
      let excess = 0;
      for (const m of models) {
        const x = anchorValue(m, record.features);
        if (x === null) continue;
        const gap = x - m.xbar;
        const d = m.deadband ?? 0;
        const move = m.gain * Math.max(0, gap - d) + (m.gainBelow ?? m.gain) * Math.min(0, gap + d);
        // Scaled by the parameter's own range so families in stops and families
        // in ±100 slider units can be compared at all.
        const range = Math.max(1, Math.abs(m.gain) * ((m.deadband ?? 0) || 1));
        excess = Math.max(excess, Math.abs(move) / range);
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
