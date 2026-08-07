/**
 * The photometric feature vector the develop predictor reads.
 *
 * Synthetic frames rather than photographs on purpose: a flat gray field, a pure
 * red field, a checkerboard — each has a feature value that can be derived on
 * paper, so a drift in the computation shows up as a wrong number rather than as
 * a slightly different prediction three commands later.
 */
import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { COLOR_FEATURE_NAMES, extractColorFeatures } from '../src/features.js';

const EDGE = 128;

/** A PNG of `edge`×`edge` pixels, coloured by the callback. */
const png = async (
  edge: number,
  color: (x: number, y: number) => [number, number, number],
): Promise<Buffer> => {
  const raw = Buffer.alloc(edge * edge * 3);
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const [r, g, b] = color(x, y);
      const o = (y * edge + x) * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  return sharp(raw, { raw: { width: edge, height: edge, channels: 3 } }).png().toBuffer();
};

const solid = (r: number, g: number, b: number) => png(EDGE, () => [r, g, b]);

/** Read one named feature out of the vector. */
const featureOf = (vector: number[], name: string): number => {
  const i = COLOR_FEATURE_NAMES.indexOf(name);
  if (i < 0) throw new Error(`no such feature: ${name}`);
  return vector[i]!;
};

describe('COLOR_FEATURE_NAMES', () => {
  test('names each feature once', () => {
    expect(new Set(COLOR_FEATURE_NAMES).size).toBe(COLOR_FEATURE_NAMES.length);
  });

  test('is index-aligned with the vector it describes', async () => {
    const { vector } = await extractColorFeatures(await solid(128, 128, 128));
    expect(vector.length).toBe(COLOR_FEATURE_NAMES.length);
  });

  test('carries the six features the develop predictor added', () => {
    for (const name of ['lumaP01', 'lumaP99', 'shadowFloor', 'detailFine', 'detailCoarse', 'darkChannel']) {
      expect(COLOR_FEATURE_NAMES).toContain(name);
    }
  });
});

describe('extractColorFeatures, on a flat gray field', () => {
  test('reads mid gray as a mid luma with no spread', async () => {
    const { vector, summary } = await extractColorFeatures(await solid(128, 128, 128));

    expect(featureOf(vector, 'lumaMean')).toBeCloseTo(128 / 255, 2);
    expect(featureOf(vector, 'lumaStd')).toBeCloseTo(0, 3);
    expect(summary.lumaMean).toBeCloseTo(128, 0);
  });

  test('reads no colour: neutral ratios and zero saturation', async () => {
    const { vector, summary } = await extractColorFeatures(await solid(128, 128, 128));

    expect(featureOf(vector, 'satMean')).toBeCloseTo(0, 3);
    expect(summary.rgRatio).toBeCloseTo(1, 2);
    expect(summary.bgRatio).toBeCloseTo(1, 2);
  });

  test('reads no detail on a field with no edges', async () => {
    const { vector } = await extractColorFeatures(await solid(128, 128, 128));
    expect(featureOf(vector, 'detailFine')).toBeCloseTo(0, 4);
    expect(featureOf(vector, 'detailCoarse')).toBeCloseTo(0, 4);
  });
});

describe('extractColorFeatures, at the ends of the range', () => {
  test('a white frame is fully clipped high and not at all in the shadows', async () => {
    const { summary, vector } = await extractColorFeatures(await solid(255, 255, 255));
    expect(summary.clipHigh).toBeCloseTo(1, 2);
    expect(summary.clipShadow).toBe(0);
    expect(featureOf(vector, 'lumaP99')).toBeCloseTo(1, 2);
  });

  test('a black frame is clipped in the shadows and nowhere else', async () => {
    const { summary, vector } = await extractColorFeatures(await solid(0, 0, 0));
    expect(summary.clipShadow).toBeCloseTo(1, 2);
    expect(summary.clipHigh).toBe(0);
    expect(featureOf(vector, 'lumaP01')).toBeCloseTo(0, 2);
    expect(featureOf(vector, 'darkChannel')).toBeCloseTo(0, 3);
  });

  test('the dark-channel prior rises with a veil over the whole frame', async () => {
    const clear = await extractColorFeatures(await png(EDGE, (x) => [x * 2, 10, 10]));
    const hazed = await extractColorFeatures(await png(EDGE, (x) => [x * 2, 120, 120]));
    expect(hazed.vector[COLOR_FEATURE_NAMES.indexOf('darkChannel')]!).toBeGreaterThan(
      clear.vector[COLOR_FEATURE_NAMES.indexOf('darkChannel')]!,
    );
  });
});

describe('extractColorFeatures, on colour', () => {
  test('a saturated red field reads as saturated and red-heavy', async () => {
    const { vector, summary } = await extractColorFeatures(await solid(240, 20, 20));
    expect(featureOf(vector, 'satMean')).toBeGreaterThan(0.9);
    expect(summary.rgRatio).toBeGreaterThan(5);
  });

  // The illuminant ratios divide by green; with no green there is no ratio to
  // report, and a neutral 1 is the honest answer rather than an infinity.
  test('reports a neutral ratio rather than dividing by a green that is not there', async () => {
    const { summary } = await extractColorFeatures(await solid(255, 0, 0));
    expect(summary.rgRatio).toBe(1);
    expect(summary.bgRatio).toBe(1);
  });

  test('a blue cast shows up in the blue/green ratio', async () => {
    const { summary } = await extractColorFeatures(await solid(80, 100, 200));
    expect(summary.bgRatio).toBeGreaterThan(1.5);
    expect(summary.rgRatio).toBeLessThan(1);
  });

  test('the hue histogram sums to about the mean saturation', async () => {
    // Every pixel contributes its saturation to exactly one hue bin.
    const { vector, summary } = await extractColorFeatures(await solid(200, 40, 40));
    const hue = COLOR_FEATURE_NAMES.filter((n) => n.startsWith('hueHist')).map((n) => featureOf(vector, n));
    expect(hue.reduce((a, b) => a + b, 0)).toBeCloseTo(summary.satMean, 2);
  });
});

describe('extractColorFeatures, on structure', () => {
  test('the luma histogram is a distribution: it sums to one', async () => {
    const { vector } = await extractColorFeatures(await png(EDGE, (x, y) => [x * 2, y * 2, 128]));
    const bins = COLOR_FEATURE_NAMES.filter((n) => n.startsWith('lumaHist')).map((n) => featureOf(vector, n));
    expect(bins.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  test('percentiles bracket the median', async () => {
    const { vector } = await extractColorFeatures(await png(EDGE, (x) => [x * 2, x * 2, x * 2]));
    expect(featureOf(vector, 'lumaP01')).toBeLessThanOrEqual(featureOf(vector, 'lumaMedian'));
    expect(featureOf(vector, 'lumaP99')).toBeGreaterThanOrEqual(featureOf(vector, 'lumaMedian'));
  });

  test('fine detail separates a checkerboard from a smooth ramp', async () => {
    const checker = await extractColorFeatures(
      await png(EDGE, (x, y) => (((x + y) & 1) === 0 ? [255, 255, 255] : [0, 0, 0])),
    );
    const ramp = await extractColorFeatures(await png(EDGE, (x) => [x * 2, x * 2, x * 2]));
    expect(featureOf(checker.vector, 'detailFine')).toBeGreaterThan(featureOf(ramp.vector, 'detailFine'));
  });

  // The point of reading it off the 2x-averaged plane at the 5th percentile: a
  // sprinkle of dead pixels must not set the black point for the frame.
  test('the shadow floor ignores a handful of black pixels', async () => {
    const clean = await extractColorFeatures(await solid(120, 120, 120));
    const speckled = await extractColorFeatures(
      await png(EDGE, (x, y) => (x === 0 && y < 4 ? [0, 0, 0] : [120, 120, 120])),
    );
    expect(featureOf(speckled.vector, 'shadowFloor')).toBeCloseTo(featureOf(clean.vector, 'shadowFloor'), 2);
  });
});

describe('extractColorFeatures, as a contract', () => {
  test('every value is finite and rounded to six decimals', async () => {
    const { vector } = await extractColorFeatures(await png(EDGE, (x, y) => [x * 2, y * 2, 200 - x]));
    for (const v of vector) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.round(v * 1e6) / 1e6).toBe(v);
    }
  });

  test('the normalized features stay inside 0..1', async () => {
    const { vector } = await extractColorFeatures(await png(EDGE, (x, y) => [x * 2, y * 2, 255 - x]));
    for (const name of COLOR_FEATURE_NAMES) {
      if (name === 'rgRatio' || name === 'bgRatio') continue; // ratios, unbounded above
      expect(featureOf(vector, name)).toBeGreaterThanOrEqual(0);
      expect(featureOf(vector, name)).toBeLessThanOrEqual(1);
    }
  });

  test('is scale-invariant enough that a resize does not change the story', async () => {
    const big = await extractColorFeatures(await png(512, (x, y) => [x % 256, y % 256, 128]));
    const small = await extractColorFeatures(await png(256, (x, y) => [(x * 2) % 256, (y * 2) % 256, 128]));
    expect(featureOf(big.vector, 'lumaMean')).toBeCloseTo(featureOf(small.vector, 'lumaMean'), 1);
  });

  test('is deterministic on the same input', async () => {
    const buffer = await png(EDGE, (x, y) => [x, y, 128]);
    expect(await extractColorFeatures(buffer)).toEqual(await extractColorFeatures(buffer));
  });
});
