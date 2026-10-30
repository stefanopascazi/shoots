/**
 * The log-luma histograms an intent is judged on, for one photograph.
 *
 * Decoded from the RAW the way the review screen decodes it (scene-linear,
 * as-shot balanced) and moved to the predicted white balance, so the look the
 * intents bound is the look the prediction produces. Only paid for when an
 * intent is asked for: a RAW decode is the slow part. Region histograms, when
 * masks are given, come from the same decode.
 */
import { decode } from '../review/preview.js';
import { toWb } from '../review/ramp.js';
import { lumaHistogram, regionHistogram, type LumaHistogram } from '../look/tone.js';
import { MASK_GRID, unpackMask, type VisionRegion } from '../../vision/record.js';
import type { AsShotMeta } from '../develop/schema.js';

/** Long edge of the decode: a histogram needs no more pixels than this. */
const DECODE_EDGE = 400;

export async function frameHistogram(file: string, develop: Record<string, number>, asShot: AsShotMeta): Promise<LumaHistogram> {
  return (await frameHistograms(file, develop, asShot)).frame;
}

export async function frameHistograms(
  file: string,
  develop: Record<string, number>,
  asShot: AsShotMeta,
  masks: Partial<Record<VisionRegion, string>> = {},
): Promise<{ frame: LumaHistogram; regions: Partial<Record<VisionRegion, LumaHistogram>> }> {
  const img = await decode(file, DECODE_EDGE);
  const wb = toWb(develop, asShot);
  const frame = lumaHistogram(img, wb);
  const regions: Partial<Record<VisionRegion, LumaHistogram>> = {};
  for (const [region, packed] of Object.entries(masks) as [VisionRegion, string][]) {
    const h = regionHistogram(img, wb, unpackMask(packed), MASK_GRID, frame.anchor);
    if (h) regions[region] = h;
  }
  return { frame, regions };
}
