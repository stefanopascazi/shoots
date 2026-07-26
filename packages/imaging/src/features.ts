/**
 * Explicit color/exposure features — our own code, no third-party model, so the
 * licence stays clean (see project constraints). These are *photometric*
 * descriptors of a rendered image: the develop predictor needs to know how
 * bright / warm / clipped a frame is, which a CLIP embedding (semantic, and
 * deliberately colour-invariant) does not carry.
 *
 * Computed from a small decoded RGB raster (downscaled for speed; histograms are
 * scale- and orientation-invariant, so no rotation handling is needed). The
 * output is a fixed-length vector plus stable names for interpretability.
 */
import sharp from 'sharp';
import { loadRenderableImage } from './thumbnail.js';

/** Edge of the square the image is fit into before pixel stats. */
const SAMPLE_EDGE = 256;
const LUMA_BINS = 16;
const HUE_BINS = 12;

export interface ColorFeatures {
  /** Fixed-length feature vector (see {@link COLOR_FEATURE_NAMES}). */
  vector: number[];
  /** A few headline scalars, handy for logging / sanity checks. */
  summary: {
    lumaMean: number;
    clipHigh: number;
    clipShadow: number;
    /** Gray-world illuminant proxy: mean R/G and B/G ratios. */
    rgRatio: number;
    bgRatio: number;
    satMean: number;
  };
}

/** Stable names, index-aligned with {@link ColorFeatures.vector}. */
export const COLOR_FEATURE_NAMES: string[] = [
  'lumaMean',
  'lumaMedian',
  'lumaStd',
  ...Array.from({ length: LUMA_BINS }, (_, i) => `lumaHist${i}`),
  'clipHigh',
  'clipShadow',
  'rMean',
  'gMean',
  'bMean',
  'rStd',
  'gStd',
  'bStd',
  'rgRatio',
  'bgRatio',
  'satMean',
  'satStd',
  'valMean',
  ...Array.from({ length: HUE_BINS }, (_, i) => `hueHist${i}`),
];

/** RGB (0..255) → HSV with h in [0,1), s in [0,1], v in [0,1]. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

/**
 * Extract photometric features from a rendered image. RAW inputs are read via
 * their embedded JPEG preview (through {@link loadRenderableImage}); pass a
 * Buffer directly for an already-decoded baseline render.
 */
export async function extractColorFeatures(input: string | Buffer): Promise<ColorFeatures> {
  const buffer =
    typeof input === 'string' ? (await loadRenderableImage(input)).buffer : input;

  const { data, info } = await sharp(buffer)
    .resize(SAMPLE_EDGE, SAMPLE_EDGE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels; // 3 after removeAlpha
  const pixels = Math.floor(data.length / channels);
  if (pixels === 0) throw new Error('color features: image decoded to zero pixels');

  const lumaHistRaw = new Float64Array(256);
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let rSq = 0;
  let gSq = 0;
  let bSq = 0;
  let satSum = 0;
  let satSq = 0;
  let valSum = 0;
  const hueHist = new Float64Array(HUE_BINS);
  let clipHigh = 0;
  let clipShadow = 0;

  for (let p = 0; p < pixels; p++) {
    const o = p * channels;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaHistRaw[Math.min(255, luma | 0)]! += 1;
    if (r >= 250 && g >= 250 && b >= 250) clipHigh++;
    if (r <= 4 && g <= 4 && b <= 4) clipShadow++;

    rSum += r;
    gSum += g;
    bSum += b;
    rSq += r * r;
    gSq += g * g;
    bSq += b * b;

    const [h, s, v] = rgbToHsv(r, g, b);
    satSum += s;
    satSq += s * s;
    valSum += v;
    // Weight the hue histogram by saturation so near-gray pixels don't smear it.
    hueHist[Math.min(HUE_BINS - 1, (h * HUE_BINS) | 0)]! += s;
  }

  const n = pixels;
  const rMean = rSum / n;
  const gMean = gSum / n;
  const bMean = bSum / n;
  const std = (sq: number, mean: number): number => Math.sqrt(Math.max(0, sq / n - mean * mean));
  const rStd = std(rSq, rMean);
  const gStd = std(gSq, gMean);
  const bStd = std(bSq, bMean);
  const satMean = satSum / n;
  const satStd = std(satSq, satMean);
  const valMean = valSum / n;

  // Luma mean/median/std from the 256-bin histogram.
  let lumaSum = 0;
  let lumaSqSum = 0;
  for (let i = 0; i < 256; i++) {
    const c = lumaHistRaw[i]!;
    lumaSum += i * c;
    lumaSqSum += i * i * c;
  }
  const lumaMean = lumaSum / n;
  const lumaStd = Math.sqrt(Math.max(0, lumaSqSum / n - lumaMean * lumaMean));
  let acc = 0;
  let lumaMedian = 0;
  const half = n / 2;
  for (let i = 0; i < 256; i++) {
    acc += lumaHistRaw[i]!;
    if (acc >= half) {
      lumaMedian = i;
      break;
    }
  }

  // Coarse, normalized luma histogram (LUMA_BINS).
  const lumaHist = new Array<number>(LUMA_BINS).fill(0);
  for (let i = 0; i < 256; i++) {
    lumaHist[Math.min(LUMA_BINS - 1, (i / 256 * LUMA_BINS) | 0)]! += lumaHistRaw[i]!;
  }
  for (let i = 0; i < LUMA_BINS; i++) lumaHist[i]! /= n;

  const hueHistNorm = Array.from(hueHist, (v) => v / n);
  const rgRatio = gMean > 1 ? rMean / gMean : 1;
  const bgRatio = gMean > 1 ? bMean / gMean : 1;

  const vector: number[] = [
    lumaMean / 255,
    lumaMedian / 255,
    lumaStd / 255,
    ...lumaHist,
    clipHigh / n,
    clipShadow / n,
    rMean / 255,
    gMean / 255,
    bMean / 255,
    rStd / 255,
    gStd / 255,
    bStd / 255,
    rgRatio,
    bgRatio,
    satMean,
    satStd,
    valMean,
    ...hueHistNorm,
  ].map((v) => Math.round(v * 1e6) / 1e6);

  return {
    vector,
    summary: {
      lumaMean: Math.round(lumaMean * 10) / 10,
      clipHigh: Math.round((clipHigh / n) * 1e4) / 1e4,
      clipShadow: Math.round((clipShadow / n) * 1e4) / 1e4,
      rgRatio: Math.round(rgRatio * 1e3) / 1e3,
      bgRatio: Math.round(bgRatio * 1e3) / 1e3,
      satMean: Math.round(satMean * 1e3) / 1e3,
    },
  };
}
