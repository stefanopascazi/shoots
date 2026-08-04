/**
 * Encoding a raster this package's callers already hold in memory.
 *
 * Exists so nothing outside `@shoots/imaging` has to import sharp. The CLI is
 * bundled as a single ESM file and sharp reaches for `require` at load time, so
 * a direct import there breaks the binary outright — the dependency belongs to
 * exactly one package and this is how the others reach it.
 */
import sharp from 'sharp';

/** Interleaved 8-bit RGB → JPEG. */
export function encodeJpeg(
  rgb: Uint8Array,
  width: number,
  height: number,
  quality = 82,
): Promise<Buffer> {
  return sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality })
    .toBuffer();
}
