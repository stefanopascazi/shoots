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
import sharp from 'sharp';
import { RAW_EXTENSIONS } from '@shoots/core';
import { extractPreview } from './exif.js';

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

  const source =
    typeof input === 'string' ? (await loadRenderableImage(input)).buffer : input;

  let pipeline = sharp(source)
    .rotate() // honor EXIF orientation
    .resize(width, height, { fit: 'inside', withoutEnlargement: true });

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
