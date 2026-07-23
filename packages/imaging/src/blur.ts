/**
 * Classic (non-ML) blur / focus detection via variance of the Laplacian.
 *
 * The image is converted to grayscale, downscaled to a bounded size for
 * speed and threshold stability, then convolved with the 4-neighbor Laplacian
 * kernel. Low variance ⇒ few edges ⇒ likely out of focus or motion-blurred.
 */
import sharp from 'sharp';
import { loadRenderableImage } from './thumbnail.js';

/**
 * Default decision threshold. Empirically, well-focused photos downscaled to
 * ~1024px land well above 100; soft/blurry frames fall below. Tune per camera
 * and subject matter with `--threshold`.
 */
export const DEFAULT_BLUR_THRESHOLD = 100;

export interface LaplacianResult {
  /** Variance of the Laplacian response. Higher = sharper. */
  score: number;
  /** Dimensions actually analyzed (after downscale). */
  width: number;
  height: number;
}

export interface LaplacianOptions {
  /** Analysis is performed on an image bounded to this size. Default: 1024. */
  maxDimension?: number;
}

export async function laplacianVariance(
  input: Buffer,
  options: LaplacianOptions = {},
): Promise<LaplacianResult> {
  const maxDim = options.maxDimension ?? 1024;
  const { data, info } = await sharp(input)
    .rotate()
    .grayscale()
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  if (width < 3 || height < 3) {
    throw new Error(`Image too small for blur analysis (${width}x${height})`);
  }

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap =
        4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return { score: variance, width, height };
}

export type BlurVerdict = 'sharp' | 'blurry';

export interface BlurAnalysis {
  file: string;
  score: number;
  verdict: BlurVerdict;
  threshold: number;
  /** Whether pixels came from the file itself or a RAW embedded preview. */
  pixelSource: 'file' | 'embedded-preview';
  analyzedWidth: number;
  analyzedHeight: number;
}

export interface AnalyzeBlurOptions extends LaplacianOptions {
  threshold?: number;
}

/** Full per-file analysis: load renderable pixels, score, classify. */
export async function analyzeBlur(
  filePath: string,
  options: AnalyzeBlurOptions = {},
): Promise<BlurAnalysis> {
  const threshold = options.threshold ?? DEFAULT_BLUR_THRESHOLD;
  const { buffer, source } = await loadRenderableImage(filePath);
  const { score, width, height } = await laplacianVariance(buffer, options);
  return {
    file: filePath,
    score,
    verdict: score >= threshold ? 'sharp' : 'blurry',
    threshold,
    pixelSource: source,
    analyzedWidth: width,
    analyzedHeight: height,
  };
}
