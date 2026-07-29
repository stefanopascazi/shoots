/**
 * Capture-session context — what the rest of the shoot looks like.
 *
 * A catalog is not a bag of independent photographs. On the reference catalog
 * the *session* accounts for 26–67% of the variance of the develop targets
 * (Saturation 67%, Shadows 57%, Highlights 49%, Exposure 26%): most of the
 * decision is "this shoot", not "this frame". A model that only ever sees one
 * frame at a time cannot represent that, and spends its capacity trying to
 * explain a session-level offset from single-image evidence.
 *
 * So each image also carries the mean photometric description of its session.
 * Measured on the reference catalog, across 12 independent session→fold
 * shuffles, this is the largest single gain found in this tool: colour skill
 * 0.046 → 0.079 and Contrast2012 9% → 36%, winning on 12 shuffles out of 12.
 *
 * Two properties worth being explicit about:
 *
 *  - It is **transductive**. A frame's prediction depends on which other frames
 *    are in its folder. That is legitimate here — you export a whole shoot and
 *    then predict on it — but it means predicting on one file in isolation is a
 *    different, weaker regime, and the caller is told so rather than left to
 *    wonder why the numbers moved.
 *  - It is **edit-independent**, computed from the baseline render only, so it
 *    can be built from unedited frames too — which the trainer does, from every
 *    record in the dataset rather than only the rows it trains on.
 *
 * Whether feeding it the *unedited* frames as well is worth the export is a
 * separate question, and the answer measured on the reference catalog is no:
 * describing each session from all 2421 frames instead of the 553 edited ones
 * moved the weighted skill by 0.02pp. Exposure2012 gained 2.6pp and won on 12
 * shuffles out of 12 — plausibly because the rejects widen the description of
 * the session's dynamic range — while Vibrance, Saturation, Dehaze and Whites
 * each lost a little on 11 or 12 out of 12. It nets out to nothing.
 */
import path from 'node:path';

/**
 * The session a photograph belongs to: its containing folder.
 *
 * A capture folder is the closest thing a catalog offers to "one shoot" without
 * reading timestamps, and it is what the photographer organises by anyway.
 */
export function sessionKey(file: string): string {
  return path.dirname(file);
}

/** Per-session mean of the photometric features, plus how many frames built it. */
export interface SessionContext {
  mean: number[];
  frames: number;
}

/** What a record has to expose to take part in the session description. */
interface Describable {
  file: string;
  features: number[];
}

/**
 * Build the per-session context from every record available.
 *
 * Deliberately takes the *whole* dataset, not the training rows: unedited frames
 * carry no target but describe the shoot just as well, and a session mean built
 * from "the ones that survived the cull" is a biased picture of the light the
 * photographer was working in.
 */
export function buildSessionContext(records: Describable[]): Map<string, SessionContext> {
  const sums = new Map<string, { sum: Float64Array; frames: number }>();
  for (const record of records) {
    if (!record.features?.length) continue;
    const key = sessionKey(record.file);
    let acc = sums.get(key);
    if (!acc) {
      acc = { sum: new Float64Array(record.features.length), frames: 0 };
      sums.set(key, acc);
    }
    if (acc.sum.length !== record.features.length) continue; // mixed dims: skip
    for (let j = 0; j < record.features.length; j++) acc.sum[j]! += record.features[j]!;
    acc.frames++;
  }
  const out = new Map<string, SessionContext>();
  for (const [key, acc] of sums) {
    out.set(key, { mean: Array.from(acc.sum, (v) => v / acc.frames), frames: acc.frames });
  }
  return out;
}

/**
 * The session mean for one file, falling back to its own features.
 *
 * A one-frame session is its own mean, which is what the fallback produces — the
 * feature then says "this frame is typical of its session", trivially true and
 * harmless. It is still worth counting those separately (see
 * {@link soloSessionCount}), because a set made entirely of them is running the
 * model outside the regime it was fitted in.
 */
export function contextFor(
  context: Map<string, SessionContext>,
  file: string,
  features: number[],
): number[] {
  const found = context.get(sessionKey(file));
  return found && found.mean.length === features.length ? found.mean : features;
}

/** How many of these files sit in a session of fewer than `min` frames. */
export function soloSessionCount(
  context: Map<string, SessionContext>,
  files: string[],
  min = 2,
): number {
  return files.filter((f) => (context.get(sessionKey(f))?.frames ?? 1) < min).length;
}
