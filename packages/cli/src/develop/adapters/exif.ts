/**
 * EXIF parsing shared by every adapter.
 *
 * Nothing here knows about an editor: these are exiftool's output conventions,
 * which every adapter meets the moment it needs the as-shot metadata off a RAW.
 * They started life in the ACR adapter and moved out when the second adapter
 * arrived — the alternative was RapidRAW importing from `acr/`, which would have
 * made a peer look like a base class.
 */

/** Coerce an exiftool value to a finite number, or null. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // exiftool renders EXIF rationals as fractions: ExposureCompensation comes
  // back as "-1/3". Stripping the slash the way the generic path below does
  // would read that as -13 — a third of a stop becoming thirteen stops, in a
  // feature the model consumes directly.
  const ratio = /^([+-]?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
  if (ratio) {
    const denominator = parseFloat(ratio[2]!);
    if (denominator === 0) return null;
    const v = parseFloat(ratio[1]!) / denominator;
    return Number.isFinite(v) ? v : null;
  }
  const n = parseFloat(text.replace(/[^0-9eE.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Local hour from an EXIF timestamp ("2025:01:01 17:42:03", optionally with a
 * zone suffix). Local on purpose: the sun is where the photographer was, so the
 * wall clock is the useful signal and converting to UTC would destroy it.
 */
export function captureHour(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^\d{4}[:-]\d{2}[:-]\d{2}[ T](\d{2}):/.exec(value.trim());
  if (!m) return null;
  const hour = parseInt(m[1]!, 10);
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

/**
 * As-shot / capture metadata tags, read edit-independently from the RAW.
 *
 * WB anchors, in order of what they mean (Canon names; other makers expose
 * equivalents that exiftool normalizes to the same tags):
 *  - `ColorTempAsShot`   the WB the camera actually recorded — the delta anchor.
 *  - `ColorTempMeasured` the camera's own *measured* scene temperature. Unlike
 *    the as-shot value it moves with the light, not with the WB dial, so it is
 *    an edit-independent estimate of the answer the photographer is about to
 *    pick. Captured for the feature vector.
 *  - `ColorTemperature`  fallback for bodies exposing neither of the above.
 */
export const META_TAGS = [
  'ColorTempAsShot', 'ColorTempMeasured', 'ColorTemperature',
  'ISO', 'ExposureCompensation', 'Model',
  // Time of day: golden hour and midday ask different things of the white
  // balance, and the pixels alone cannot tell a warm noon from a neutral sunset.
  'DateTimeOriginal', 'CreateDate',
] as const;
