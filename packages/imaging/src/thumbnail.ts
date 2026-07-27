/**
 * sharp-based preview/thumbnail handling.
 *
 * sharp (libvips) cannot demosaic RAW files — and per project scope we don't
 * implement demosaicing. For RAW inputs we extract the embedded JPEG preview
 * via exiftool and feed *that* to sharp. Future seam: darktable-cli /
 * rawtherapee-cli could plug in here for full RAW rendering.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { RAW_EXTENSIONS } from '@shoots/core';
import { extractPreview, readOrientation } from './exif.js';

export function isRawFile(filePath: string): boolean {
  return RAW_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase());
}

export interface RenderableImage {
  buffer: Buffer;
  /** Where the pixels came from: the file itself, or an embedded RAW preview. */
  source: 'file' | 'embedded-preview';
}

/**
 * Get a buffer sharp can decode for any supported input:
 * - JPG/PNG/TIFF/WebP → the file bytes
 * - RAW → embedded JPEG preview via exiftool
 * Throws when a RAW file carries no usable embedded preview.
 */
export async function loadRenderableImage(filePath: string): Promise<RenderableImage> {
  if (isRawFile(filePath)) {
    const preview = await extractPreview(filePath);
    if (preview) return { buffer: preview, source: 'embedded-preview' };
    throw new Error(
      `No embedded JPEG preview found in RAW file: ${filePath} (full RAW decode is out of scope)`,
    );
  }
  return { buffer: await readFile(filePath), source: 'file' };
}

export interface ThumbnailOptions {
  /** Bounding-box width. Default: 512. */
  width?: number;
  /** Bounding-box height. Default: same as width. */
  height?: number;
  format?: 'jpeg' | 'png' | 'webp';
  /** JPEG/WebP quality. Default: 82. */
  quality?: number;
  /** When set, the thumbnail is also written to this path. */
  dest?: string;
}

/**
 * Apply an EXIF orientation (1–8) to a sharp pipeline explicitly. Used when the
 * pixels carry no orientation tag of their own (a RAW's embedded preview), so
 * sharp's metadata-driven `.rotate()` would be a no-op. Rotations are clockwise;
 * 5/7 are the mirrored diagonals (rare but handled for completeness).
 */
function applyExifOrientation(pipeline: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2:
      return pipeline.flop();
    case 3:
      return pipeline.rotate(180);
    case 4:
      return pipeline.flip();
    case 5:
      return pipeline.rotate(90).flop();
    case 6:
      return pipeline.rotate(90);
    case 7:
      return pipeline.rotate(270).flop();
    case 8:
      return pipeline.rotate(270);
    default:
      return pipeline;
  }
}

/**
 * Generate a thumbnail from a file path or an already-loaded buffer.
 * Never modifies the input; returns the encoded thumbnail buffer.
 */
export async function generateThumbnail(
  input: string | Buffer,
  options: ThumbnailOptions = {},
): Promise<Buffer> {
  const width = options.width ?? 512;
  const height = options.height ?? width;
  const format = options.format ?? 'jpeg';
  const quality = options.quality ?? 82;

  const loaded =
    typeof input === 'string'
      ? await loadRenderableImage(input)
      : { buffer: input, source: 'file' as const };

  let pipeline = sharp(loaded.buffer);

  // Orientation: normal files carry an EXIF Orientation tag that sharp honors via
  // `.rotate()`. A RAW's embedded preview usually lacks it (the tag lives in the
  // RAW), so read the original's orientation and apply it explicitly — otherwise
  // portrait shots come out landscape.
  const previewMeta = loaded.source === 'embedded-preview' ? await sharp(loaded.buffer).metadata() : null;
  if (loaded.source === 'embedded-preview' && typeof input === 'string' && !previewMeta?.orientation) {
    pipeline = applyExifOrientation(pipeline, await readOrientation(input));
  } else {
    pipeline = pipeline.rotate(); // honor the pixels' own EXIF orientation
  }

  pipeline = pipeline.resize(width, height, { fit: 'inside', withoutEnlargement: true });

  pipeline =
    format === 'png'
      ? pipeline.png()
      : format === 'webp'
        ? pipeline.webp({ quality })
        : pipeline.jpeg({ quality });

  const buffer = await pipeline.toBuffer();
  if (options.dest) await writeFile(options.dest, buffer);
  return buffer;
}
