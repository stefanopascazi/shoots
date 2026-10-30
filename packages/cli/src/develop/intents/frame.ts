/**
 * The log-luma histogram an intent is judged on, for one photograph.
 *
 * Decoded from the RAW the way the review screen decodes it (scene-linear,
 * as-shot balanced) and moved to the predicted white balance, so the look the
 * intents bound is the look the prediction produces. Only paid for when an
 * intent is asked for: a RAW decode is the slow part.
 */
import { decode } from '../review/preview.js';
import { toWb } from '../review/ramp.js';
import { lumaHistogram, type LumaHistogram } from '../look/tone.js';
import type { AsShotMeta } from '../develop/schema.js';

/** Long edge of the decode: a histogram needs no more pixels than this. */
const DECODE_EDGE = 400;

export async function frameHistogram(file: string, develop: Record<string, number>, asShot: AsShotMeta): Promise<LumaHistogram> {
  return lumaHistogram(await decode(file, DECODE_EDGE), toWb(develop, asShot));
}
