/**
 * What the vision model reads in one photograph, as cached and as consumed.
 *
 * One pass serves two features: keywords (caption + detected objects) and
 * region intents (where the sky and the subject are). Masks are stored on a
 * small grid, packed one bit per cell: enough to measure a region's brightness
 * on a preview, small enough to cache for every frame of a catalog.
 */

/** Cells per side of a stored region mask. */
export const MASK_GRID = 48;

export interface VisionObject {
  label: string;
  /** [x0, y0, x1, y1] as fractions of the upright frame, 0..1. */
  box: [number, number, number, number];
}

export interface VisionRecord {
  caption: string;
  objects: VisionObject[];
  /** Region name → packed MASK_GRID² bitmask (base64); a region absent from the photograph has no entry. */
  regions: Partial<Record<VisionRegion, string>>;
}

/** The regions intents can name. */
export type VisionRegion = 'sky' | 'subject';

/** One bit per cell, row-major, base64. */
export function packMask(mask: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i++) if (mask[i]) bytes[i >> 3]! |= 1 << (i & 7);
  return Buffer.from(bytes).toString('base64');
}

export function unpackMask(packed: string, cells = MASK_GRID * MASK_GRID): Uint8Array {
  const bytes = Buffer.from(packed, 'base64');
  const mask = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) mask[i] = (bytes[i >> 3]! >> (i & 7)) & 1;
  return mask;
}

/** Share of the frame a packed mask covers, 0..1. */
export function maskShare(packed: string): number {
  const m = unpackMask(packed);
  return m.reduce((a, b) => a + b, 0) / m.length;
}

/**
 * A record in the shape callers can trust: every field present and typed.
 * Refuses (null) anything that is not, so a damaged cache entry is recomputed
 * rather than half-read.
 */
export function readRecord(value: unknown): VisionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<VisionRecord>;
  if (typeof v.caption !== 'string' || !Array.isArray(v.objects) || !v.regions || typeof v.regions !== 'object') return null;
  return { caption: v.caption, objects: v.objects, regions: v.regions };
}
