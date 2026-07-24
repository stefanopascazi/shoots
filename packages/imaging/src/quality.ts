/**
 * Image helpers for the ONNX quality backend: CLIP preprocessing and cheap
 * technical-aesthetic statistics. Kept here because this package owns sharp;
 * @shoots/inference composes these with model inference and Laplacian focus.
 */
import sharp from 'sharp';

export interface ClipPreprocessOptions {
  /** Square input side (CLIP ViT-B/32 = 224). */
  size: number;
  /** Per-channel mean (RGB), applied after rescaling to [0,1]. */
  mean: [number, number, number];
  /** Per-channel std (RGB). */
  std: [number, number, number];
}

/**
 * CLIP image preprocessing: honor EXIF orientation, resize the shortest edge to
 * `size` (bicubic) with a centered square crop, drop alpha, rescale to [0,1] and
 * normalize per channel. Returns a CHW float32 tensor of shape [3, size, size].
 */
export async function preprocessClip(input: Buffer, opts: ClipPreprocessOptions): Promise<Float32Array> {
  const { size, mean, std } = opts;
  const { data } = await sharp(input)
    .rotate()
    .resize(size, size, { fit: 'cover', position: 'centre', kernel: 'cubic' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    const src = p * 3; // HWC, 3 channels
    for (let c = 0; c < 3; c++) {
      out[c * plane + p] = (data[src + c] / 255 - mean[c]) / std[c];
    }
  }
  return out;
}

export interface AestheticStats {
  /** Mean luma in [0,1]. */
  brightness: number;
  /** Global luma contrast (stdev) in [0,1]. */
  contrast: number;
  /** Colorfulness proxy (mean per-channel spread) in [0,1]. */
  colorfulness: number;
}

/**
 * Cheap perceptual statistics from a single sharp `stats()` pass. Used by the
 * heuristic (no-ML) part of the aesthetic score.
 */
export async function aestheticStats(input: Buffer): Promise<AestheticStats> {
  const { channels } = await sharp(input).rotate().removeAlpha().stats();
  // channels: [R, G, B] with mean/stdev in 0..255.
  const [r, g, b] = channels;
  const brightness = (0.299 * r.mean + 0.587 * g.mean + 0.114 * b.mean) / 255;
  const contrast = Math.min(1, (0.299 * r.stdev + 0.587 * g.stdev + 0.114 * b.stdev) / 128);
  const colorfulness = Math.min(1, (r.stdev + g.stdev + b.stdev) / 3 / 128);
  return { brightness, contrast, colorfulness };
}
