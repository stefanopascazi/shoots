/**
 * Classic (non-ML) blur / focus detection via variance of the Laplacian.
 *
 * The image is converted to grayscale, downscaled to a bounded size for
 * speed and threshold stability, then convolved with the 4-neighbor Laplacian
 * kernel. Low variance ⇒ few edges ⇒ likely out of focus or motion-blurred.
 *
 * A single global variance, however, misjudges shallow-depth-of-field shots:
 * a wide-aperture portrait is mostly smooth bokeh, so the global score is low
 * even though the subject (eyes, lashes) is tack-sharp. To tell those apart
 * from genuinely blurry frames we also build a focus map over a tile grid and
 * take a robust peak — the sharpness of the sharpest region. A motion-blurred
 * or missed-focus frame is soft *everywhere* (low peak); a shallow-DoF keeper
 * has at least one in-focus region (high peak).
 */
import sharp from 'sharp';
import { loadRenderableImage } from './thumbnail.js';

/**
 * Default decision threshold. Empirically, well-focused photos downscaled to
 * ~1024px land well above 100; soft/blurry frames fall below. Tune per camera
 * and subject matter with `--threshold`.
 */
export const DEFAULT_BLUR_THRESHOLD = 100;

/**
 * Default focus-peak threshold. A tile that is genuinely in focus (eyelashes,
 * iris, fabric weave) scores far above this; soft/bokeh tiles sit near zero.
 * Used to rescue shallow-depth-of-field shots whose subject is sharp even
 * though most of the frame is intentionally blurred.
 */
export const DEFAULT_FOCUS_THRESHOLD = 250;

/** Focus map is computed over an up-to N×N grid of tiles. */
const FOCUS_TILE_GRID = 8;
/** Robust peak = mean of the sharpest this-fraction of tiles (ignores a lone noisy tile). */
const FOCUS_TOP_TILE_FRACTION = 0.05;
/** Never split into tiles smaller than this many pixels per side. */
const MIN_TILE_PX = 16;

/**
 * Per-tile sharpness over the analysed frame, row-major. Lets callers see
 * *where* the in-focus region sits (e.g. to draw a focus heatmap).
 */
export interface FocusMap {
  cols: number;
  rows: number;
  /** Laplacian variance per tile, length `cols * rows`, row-major. */
  tiles: number[];
}

export interface LaplacianResult {
  /** Variance of the Laplacian over the whole frame. Higher = sharper overall. */
  score: number;
  /**
   * Sharpness of the sharpest region: a robust peak over the tile grid. High
   * when *any* part of the frame is in focus — even if the rest is soft
   * (shallow depth of field). Low only when nothing is in focus (motion blur
   * or missed focus).
   */
  focusPeak: number;
  /** Spatial sharpness grid (see {@link FocusMap}). */
  focusMap: FocusMap;
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

  // Tile grid for the focus map, shrunk on tiny images so tiles stay meaningful.
  const cols = Math.max(1, Math.min(FOCUS_TILE_GRID, Math.floor(width / MIN_TILE_PX)));
  const rows = Math.max(1, Math.min(FOCUS_TILE_GRID, Math.floor(height / MIN_TILE_PX)));
  const tileW = Math.ceil(width / cols);
  const tileH = Math.ceil(height / rows);
  const tileCount = cols * rows;
  const tileSum = new Float64Array(tileCount);
  const tileSumSq = new Float64Array(tileCount);
  const tileN = new Uint32Array(tileCount);

  // Single pass: accumulate the Laplacian's variance globally and per tile.
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    const tileRow = Math.min(rows - 1, (y / tileH) | 0) * cols;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap =
        4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width];
      sum += lap;
      sumSq += lap * lap;
      n++;
      const t = tileRow + Math.min(cols - 1, (x / tileW) | 0);
      tileSum[t] += lap;
      tileSumSq[t] += lap * lap;
      tileN[t]++;
    }
  }
  const mean = sum / n;
  const score = sumSq / n - mean * mean;

  // Per-tile variance (kept in spatial order for the focus map), then a robust
  // peak over the sharpest tiles.
  const tiles: number[] = new Array<number>(tileCount).fill(0);
  for (let t = 0; t < tileCount; t++) {
    const tn = tileN[t];
    if (tn === 0) continue;
    const tMean = tileSum[t] / tn;
    tiles[t] = tileSumSq[t] / tn - tMean * tMean;
  }
  const ranked = tiles.filter((_, t) => tileN[t] > 0).sort((a, b) => b - a);
  const topK = Math.max(1, Math.round(ranked.length * FOCUS_TOP_TILE_FRACTION));
  let peak = 0;
  for (let k = 0; k < topK; k++) peak += ranked[k];
  const focusPeak = peak / topK;

  return { score, focusPeak, focusMap: { cols, rows, tiles }, width, height };
}

export type BlurVerdict = 'sharp' | 'blurry';

export interface BlurAnalysis {
  file: string;
  /** Global Laplacian variance (overall sharp-edge density). */
  score: number;
  /** Robust peak local sharpness — how sharp the sharpest region is. */
  focusPeak: number;
  /** Spatial sharpness grid — where the in-focus region sits. */
  focusMap: FocusMap;
  verdict: BlurVerdict;
  threshold: number;
  focusThreshold: number;
  /** True when a globally-soft frame was kept sharp because a region is in focus. */
  rescued: boolean;
  /** Whether pixels came from the file itself or a RAW embedded preview. */
  pixelSource: 'file' | 'embedded-preview';
  analyzedWidth: number;
  analyzedHeight: number;
}

export interface AnalyzeBlurOptions extends LaplacianOptions {
  threshold?: number;
  /** Focus-peak above which a globally-soft frame is rescued. Default: {@link DEFAULT_FOCUS_THRESHOLD}. */
  focusThreshold?: number;
  /** Rescue shallow-DoF frames whose subject is in focus. Default: true. */
  focusRescue?: boolean;
}

/** Full per-file analysis: load renderable pixels, score, classify. */
export async function analyzeBlur(
  filePath: string,
  options: AnalyzeBlurOptions = {},
): Promise<BlurAnalysis> {
  const threshold = options.threshold ?? DEFAULT_BLUR_THRESHOLD;
  const focusThreshold = options.focusThreshold ?? DEFAULT_FOCUS_THRESHOLD;
  const focusRescue = options.focusRescue ?? true;
  const { buffer, source } = await loadRenderableImage(filePath);
  const { score, focusPeak, focusMap, width, height } = await laplacianVariance(buffer, options);

  const globallySoft = score < threshold;
  const hasFocusedRegion = focusPeak >= focusThreshold;
  const rescued = globallySoft && focusRescue && hasFocusedRegion;
  const verdict: BlurVerdict = globallySoft && !rescued ? 'blurry' : 'sharp';

  return {
    file: filePath,
    score,
    focusPeak,
    focusMap,
    verdict,
    threshold,
    focusThreshold,
    rescued,
    pixelSource: source,
    analyzedWidth: width,
    analyzedHeight: height,
  };
}
