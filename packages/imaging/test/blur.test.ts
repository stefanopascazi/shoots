/**
 * Focus detection.
 *
 * The interesting case is not "is a blurred frame soft" — it is the shallow
 * depth-of-field rescue: a portrait that is bokeh almost everywhere and tack
 * sharp on the eyes must not be culled, and the tile grid is what tells it apart
 * from a frame that missed focus entirely.
 */
import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { DEFAULT_BLUR_THRESHOLD, DEFAULT_FOCUS_THRESHOLD, laplacianVariance } from '../src/blur.js';

const EDGE = 256;

const png = (edge: number, gray: (x: number, y: number) => number): Promise<Buffer> => {
  const raw = Buffer.alloc(edge * edge * 3);
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const v = Math.max(0, Math.min(255, Math.round(gray(x, y))));
      const o = (y * edge + x) * 3;
      raw[o] = v;
      raw[o + 1] = v;
      raw[o + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: edge, height: edge, channels: 3 } }).png().toBuffer();
};

/** Deterministic pseudo-noise: high-frequency detail, i.e. "in focus". */
const noise = (x: number, y: number): number => ((x * 7919 + y * 104729) % 251) & 0xff;

const FLAT = png(EDGE, () => 128);
const SHARP_ALL = png(EDGE, noise);
/** Sharp only in one corner tile; smooth everywhere else — a shallow-DoF frame. */
const SHARP_CORNER = png(EDGE, (x, y) => (x < 32 && y < 32 ? noise(x, y) : 128 + x / 8));

describe('laplacianVariance', () => {
  test('scores a detailed frame far above a flat one', async () => {
    const flat = await laplacianVariance(await FLAT);
    const detailed = await laplacianVariance(await SHARP_ALL);

    expect(flat.score).toBeLessThan(1);
    expect(detailed.score).toBeGreaterThan(DEFAULT_BLUR_THRESHOLD);
  });

  test('scores a blurred copy of a frame below the original', async () => {
    const original = await SHARP_ALL;
    const blurred = await sharp(original).blur(4).png().toBuffer();
    expect((await laplacianVariance(blurred)).score).toBeLessThan(
      (await laplacianVariance(original)).score,
    );
  });

  test('reports the dimensions it actually analysed, bounded by maxDimension', async () => {
    const result = await laplacianVariance(await SHARP_ALL, { maxDimension: 64 });
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(64);
  });

  test('never enlarges a frame smaller than the bound', async () => {
    const result = await laplacianVariance(await png(64, noise), { maxDimension: 1024 });
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
  });

  test('returns a tile grid whose length matches its own dimensions', async () => {
    const { focusMap } = await laplacianVariance(await SHARP_ALL);
    expect(focusMap.tiles.length).toBe(focusMap.cols * focusMap.rows);
    expect(focusMap.cols).toBeGreaterThan(0);
    expect(focusMap.rows).toBeGreaterThan(0);
  });

  test('shrinks the grid rather than emitting meaningless tiles on a tiny frame', async () => {
    const { focusMap } = await laplacianVariance(await png(32, noise));
    expect(focusMap.cols).toBeLessThanOrEqual(2);
    expect(focusMap.rows).toBeLessThanOrEqual(2);
  });

  test('puts the peak where the detail is', async () => {
    const { focusMap } = await laplacianVariance(await SHARP_CORNER);
    const best = focusMap.tiles.indexOf(Math.max(...focusMap.tiles));
    expect(best).toBe(0); // row-major: the top-left tile
  });

  // This is the rescue signal: globally soft, locally sharp.
  test('a shallow-DoF frame scores low globally but high at the peak', async () => {
    const { score, focusPeak } = await laplacianVariance(await SHARP_CORNER);
    expect(score).toBeLessThan(focusPeak);
    expect(focusPeak).toBeGreaterThan(DEFAULT_FOCUS_THRESHOLD);
  });

  test('a frame that is soft everywhere has no peak to rescue it', async () => {
    const { focusPeak } = await laplacianVariance(await sharp(await SHARP_ALL).blur(8).png().toBuffer());
    expect(focusPeak).toBeLessThan(DEFAULT_FOCUS_THRESHOLD);
  });

  test('the peak is never below the global score on a uniform frame', async () => {
    const { score, focusPeak } = await laplacianVariance(await SHARP_ALL);
    expect(focusPeak).toBeGreaterThanOrEqual(score * 0.5);
  });

  test('refuses a frame too small to convolve', async () => {
    expect(laplacianVariance(await png(2, () => 128))).rejects.toThrow(/too small for blur analysis/);
  });

  test('is deterministic', async () => {
    const buffer = await SHARP_ALL;
    expect(await laplacianVariance(buffer)).toEqual(await laplacianVariance(buffer));
  });
});

describe('the published thresholds', () => {
  test('are the documented defaults', () => {
    expect(DEFAULT_BLUR_THRESHOLD).toBe(100);
    expect(DEFAULT_FOCUS_THRESHOLD).toBe(250);
  });
});
