/**
 * Reader for floating-point DNG — the format Lightroom's HDR Merge and
 * Panorama Merge produce, and the one every landscape workflow ends up full of.
 *
 * These files are *not* Bayer mosaics: they are already demosaiced, scene-linear
 * RGB stored as 16-bit half-floats (`SampleFormat = Float`,
 * `PhotometricInterpretation = LinearRaw`), Deflate-compressed with TIFF's
 * floating-point predictor. LibRaw's dcraw_emu rejects them outright ("Cannot
 * unpack: Corrupted data or unexpected EOF") because it expects a CFA, and
 * libvips has no DNG loader at all — so without this reader an HDR merge simply
 * cannot enter a develop dataset.
 *
 * Reading them ourselves is actually the *better* baseline: the linear IFD is the
 * unedited, camera-neutral merge result, with no camera picture style baked in
 * and no risk of an edited preview leaking the target.
 *
 * Adobe writes a resolution pyramid (e.g. 6000 / 2048 / 512 / 256), so we decode
 * the smallest level that still satisfies the caller — photometric statistics are
 * scale-invariant, and a 512px level costs ~1MB instead of ~300MB.
 *
 * Everything here is our own code over zlib: no third-party decoder, no DNG SDK,
 * so the licence stays clean for commercial redistribution.
 */
import { open } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

/** TIFF tags we need. */
const TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  Predictor: 317,
  SubIFDs: 330,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SampleFormat: 339,
  // DNG colour calibration (all in IFD0).
  BlackLevel: 50714,
  WhiteLevel: 50717,
  AsShotNeutral: 50728,
  ForwardMatrix1: 50964,
  ForwardMatrix2: 50965,
} as const;

const PHOTOMETRIC_LINEAR_RAW = 34892;
const COMPRESSION_ADOBE_DEFLATE = 8;
const COMPRESSION_DEFLATE = 32946;
const SAMPLE_FORMAT_FLOAT = 3;
const PREDICTOR_FLOATING_POINT = 3;
const PREDICTOR_HORIZONTAL = 2;

/** Byte width of each TIFF field type, indexed by type code. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface IfdEntry {
  type: number;
  count: number;
  /** Raw value bytes when inline (≤4), otherwise the offset they live at. */
  valueOffset: number;
  inline: boolean;
}

type Ifd = Map<number, IfdEntry>;

class Reader {
  constructor(
    private readonly buf: Buffer,
    private readonly little: boolean,
  ) {}

  u16(at: number): number {
    return this.little ? this.buf.readUInt16LE(at) : this.buf.readUInt16BE(at);
  }
  u32(at: number): number {
    return this.little ? this.buf.readUInt32LE(at) : this.buf.readUInt32BE(at);
  }

  /** Read an IFD at `offset`; returns its entries plus the next-IFD offset. */
  ifd(offset: number): { entries: Ifd; next: number } {
    const count = this.u16(offset);
    const entries: Ifd = new Map();
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const tag = this.u16(at);
      const type = this.u16(at + 2);
      const n = this.u32(at + 4);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      entries.set(tag, {
        type,
        count: n,
        valueOffset: size <= 4 ? at + 8 : this.u32(at + 8),
        inline: size <= 4,
      });
    }
    return { entries, next: this.u32(offset + 2 + count * 12) };
  }

  /** Numeric values of an entry (handles the types DNG actually uses). */
  values(entry: IfdEntry): number[] {
    const out: number[] = [];
    const base = entry.valueOffset;
    for (let i = 0; i < entry.count; i++) {
      switch (entry.type) {
        case 1:
        case 6:
        case 7:
          out.push(this.buf.readUInt8(base + i));
          break;
        case 3:
          out.push(this.u16(base + i * 2));
          break;
        case 4:
          out.push(this.u32(base + i * 4));
          break;
        case 5:
          out.push(this.u32(base + i * 8) / (this.u32(base + i * 8 + 4) || 1));
          break;
        case 10: {
          const num = this.little ? this.buf.readInt32LE(base + i * 8) : this.buf.readInt32BE(base + i * 8);
          const den = this.little ? this.buf.readInt32LE(base + i * 8 + 4) : this.buf.readInt32BE(base + i * 8 + 4);
          out.push(num / (den || 1));
          break;
        }
        default:
          out.push(0);
      }
    }
    return out;
  }

  first(entries: Ifd, tag: number): number | undefined {
    const e = entries.get(tag);
    return e ? this.values(e)[0] : undefined;
  }
}

/** Half-precision (IEEE 754 binary16) → float. */
function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exponent = (h & 0x7c00) >> 10;
  const fraction = h & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

/**
 * Undo TIFF predictor 3 (floating point) for one row, in place.
 *
 * The encoder splits every sample into its constituent bytes and groups them
 * into byte planes across the row (all high bytes, then all low bytes), then
 * horizontally differences the resulting byte stream. Reversing means
 * accumulating the differences first, then interleaving the planes back into
 * samples — mirroring libtiff's `fpAcc`.
 */
function undoFloatPredictor(
  row: Buffer,
  sampleCount: number,
  bytesPerSample: number,
  channels: number,
  msbPlaneFirst: boolean,
): void {
  const total = sampleCount * bytesPerSample;
  // 1. Accumulate the byte-wise differences. The lag is samples-per-pixel, not
  //    the row length — libtiff differences the *planar* stream with
  //    stride = SamplesPerPixel.
  for (let i = channels; i < total; i++) {
    row[i] = (row[i] + row[i - channels]) & 0xff;
  }
  // 2. Interleave the byte planes back into samples. The encoder emits the most
  //    significant byte plane first (that is what makes the stream compress), so
  //    plane order is reversed relative to little-endian sample layout.
  const tmp = Buffer.from(row.subarray(0, total));
  for (let s = 0; s < sampleCount; s++) {
    for (let b = 0; b < bytesPerSample; b++) {
      const plane = msbPlaneFirst ? bytesPerSample - b - 1 : b;
      row[s * bytesPerSample + b] = tmp[plane * sampleCount + s];
    }
  }
}

/** Undo TIFF predictor 2 (horizontal differencing) on integer samples. */
function undoHorizontalPredictor(row: Buffer, samplesPerRow: number, channels: number): void {
  for (let i = channels; i < samplesPerRow * channels; i++) {
    row[i] = (row[i] + row[i - channels]) & 0xff;
  }
}

/** DNG colour calibration needed to get from camera space to sRGB. */
export interface DngCalibration {
  /** Per-channel white/black points; float DNGs use 32768/0. */
  whiteLevel: number;
  blackLevel: number;
  /** Camera neutral (the as-shot white balance), one multiplier per channel. */
  asShotNeutral: number[] | null;
  /** Camera → XYZ(D50), the DNG "forward matrix", row-major 3×3. */
  forwardMatrix: number[] | null;
}

export interface FloatDngImage {
  width: number;
  height: number;
  /** Interleaved RGB, scene-linear, camera colour space. */
  data: Float32Array;
  channels: number;
  calibration: DngCalibration;
}

export interface FloatDngOptions {
  /**
   * Smallest acceptable long edge. The smallest pyramid level at or above this
   * is decoded. Default 512 — ample for photometric statistics.
   */
  minEdge?: number;
  /**
   * Byte-plane order used by the floating-point predictor. Adobe writes the most
   * significant plane first; exposed only so the decoder can be validated against
   * a real file rather than asserted. See `undoFloatPredictor`.
   */
  msbPlaneFirst?: boolean;
}

/**
 * Decode the linear-raw image from a floating-point DNG.
 * Returns null when the file is not a float DNG (any other input is somebody
 * else's job — callers fall back to their normal path).
 */
export async function readFloatDng(file: string, options: FloatDngOptions = {}): Promise<FloatDngImage | null> {
  const minEdge = options.minEdge ?? 512;
  const msbPlaneFirst = options.msbPlaneFirst ?? true;
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(8);
    await handle.read(header, 0, 8, 0);
    const little = header.toString('ascii', 0, 2) === 'II';
    if (!little && header.toString('ascii', 0, 2) !== 'MM') return null;
    const magic = little ? header.readUInt16LE(2) : header.readUInt16BE(2);
    if (magic !== 42) return null; // BigTIFF (43) not produced by Lightroom merges

    // The IFD tree is tiny; the pixel payload is not. Read a generous head
    // region for structure, then pull only the tiles we need by offset.
    const { size } = await handle.stat();
    const headLen = Math.min(size, 1 << 20);
    const head = Buffer.alloc(headLen);
    await handle.read(head, 0, headLen, 0);
    const r = new Reader(head, little);

    // Collect IFD0 plus every SubIFD it points at.
    const candidates: Ifd[] = [];
    const firstOffset = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
    if (firstOffset + 2 > headLen) return null;
    const root = r.ifd(firstOffset);
    candidates.push(root.entries);
    const subEntry = root.entries.get(TAG.SubIFDs);
    if (subEntry) {
      for (const off of r.values(subEntry)) {
        if (off + 2 < headLen) candidates.push(r.ifd(off).entries);
      }
    }

    // Keep only float LinearRaw levels, then take the smallest one that still
    // meets minEdge (falling back to the largest available if none does).
    const levels = candidates
      .map((entries) => ({
        entries,
        width: r.first(entries, TAG.ImageWidth) ?? 0,
        height: r.first(entries, TAG.ImageLength) ?? 0,
        photometric: r.first(entries, TAG.PhotometricInterpretation),
        sampleFormat: r.first(entries, TAG.SampleFormat),
        bits: r.first(entries, TAG.BitsPerSample) ?? 0,
        channels: r.first(entries, TAG.SamplesPerPixel) ?? 0,
      }))
      .filter(
        (l) =>
          l.photometric === PHOTOMETRIC_LINEAR_RAW &&
          l.sampleFormat === SAMPLE_FORMAT_FLOAT &&
          l.channels >= 3 &&
          l.width > 0 &&
          l.height > 0,
      )
      .sort((a, b) => a.width - b.width);

    if (levels.length === 0) return null; // not a float DNG
    const level = levels.find((l) => Math.max(l.width, l.height) >= minEdge) ?? levels[levels.length - 1];

    const { entries, width, height, channels } = level;
    const bytesPerSample = level.bits / 8;
    if (bytesPerSample !== 2 && bytesPerSample !== 4) return null; // fp16/fp32 only

    const compression = r.first(entries, TAG.Compression);
    if (compression !== COMPRESSION_ADOBE_DEFLATE && compression !== COMPRESSION_DEFLATE) return null;
    const predictor = r.first(entries, TAG.Predictor) ?? 1;

    // Tiled or stripped — Lightroom uses tiles at full size, strips for small levels.
    const tileWidth = r.first(entries, TAG.TileWidth);
    const tileLength = r.first(entries, TAG.TileLength);
    const tiled = tileWidth !== undefined && tileLength !== undefined;
    const offsetsEntry = entries.get(tiled ? TAG.TileOffsets : TAG.StripOffsets);
    const countsEntry = entries.get(tiled ? TAG.TileByteCounts : TAG.StripByteCounts);
    if (!offsetsEntry || !countsEntry) return null;
    const offsets = r.values(offsetsEntry);
    const counts = r.values(countsEntry);

    const blockW = tiled ? tileWidth! : width;
    const blockH = tiled ? tileLength! : (r.first(entries, TAG.RowsPerStrip) ?? height);
    const across = Math.ceil(width / blockW);

    const out = new Float32Array(width * height * 3);

    for (let i = 0; i < offsets.length; i++) {
      const raw = Buffer.alloc(counts[i]);
      await handle.read(raw, 0, counts[i], offsets[i]);
      let block: Buffer;
      try {
        block = inflateSync(raw);
      } catch {
        continue; // a damaged block leaves its region black rather than failing the file
      }

      const originX = tiled ? (i % across) * blockW : 0;
      const originY = tiled ? Math.floor(i / across) * blockH : i * blockH;
      const rowBytes = blockW * channels * bytesPerSample;

      for (let y = 0; y < blockH; y++) {
        const destY = originY + y;
        if (destY >= height) break;
        const rowStart = y * rowBytes;
        if (rowStart + rowBytes > block.length) break;
        const row = block.subarray(rowStart, rowStart + rowBytes);

        if (predictor === PREDICTOR_FLOATING_POINT) {
          undoFloatPredictor(row, blockW * channels, bytesPerSample, channels, msbPlaneFirst);
        } else if (predictor === PREDICTOR_HORIZONTAL) {
          undoHorizontalPredictor(row, blockW, channels);
        }

        for (let x = 0; x < blockW; x++) {
          const destX = originX + x;
          if (destX >= width) break;
          const dest = (destY * width + destX) * 3;
          for (let c = 0; c < 3; c++) {
            const at = (x * channels + c) * bytesPerSample;
            out[dest + c] =
              bytesPerSample === 2
                ? halfToFloat(little ? row.readUInt16LE(at) : row.readUInt16BE(at))
                : little
                  ? row.readFloatLE(at)
                  : row.readFloatBE(at);
          }
        }
      }
    }

    // Calibration lives in IFD0 regardless of which pyramid level we decoded.
    const asShotEntry = root.entries.get(TAG.AsShotNeutral);
    const fwdEntry = root.entries.get(TAG.ForwardMatrix2) ?? root.entries.get(TAG.ForwardMatrix1);
    const calibration: DngCalibration = {
      whiteLevel: r.first(root.entries, TAG.WhiteLevel) ?? 32768,
      blackLevel: r.first(root.entries, TAG.BlackLevel) ?? 0,
      asShotNeutral: asShotEntry ? r.values(asShotEntry) : null,
      forwardMatrix: fwdEntry && fwdEntry.count >= 9 ? r.values(fwdEntry).slice(0, 9) : null,
    };

    return { width, height, data: out, channels: 3, calibration };
  } finally {
    await handle.close();
  }
}

/** Quick structural test — true when the file is a float (HDR/pano merge) DNG. */
export async function isFloatDng(file: string): Promise<boolean> {
  if (!/\.dng$/i.test(file)) return false;
  try {
    return (await readFloatDng(file, { minEdge: 1 })) !== null;
  } catch {
    return false;
  }
}

/** XYZ(D50) → linear sRGB, Bradford-adapted (the DNG PCS is D50). */
const XYZ_D50_TO_SRGB = [
  3.1338561, -1.6168667, -0.4906146,
  -0.9787684, 1.9161415, 0.0334540,
  0.0719453, -0.2289914, 1.4052427,
];

/** Linear → sRGB transfer function. */
function srgbEncode(v: number): number {
  if (v <= 0.0031308) return 12.92 * v;
  return 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Convert a decoded float DNG to an 8-bit sRGB raster, applying the file's own
 * DNG calibration: as-shot white balance, the forward matrix into XYZ, then sRGB.
 *
 * The intent is to match what the external RAW developer produces for ordinary
 * RAW files (`dcraw_emu -w -W -o 1`): camera white balance, standard colour, and
 * crucially **no auto-brighten**, so the true scene exposure survives into the
 * photometric features. Without that, HDR merges would sit on a different
 * exposure scale than the rest of the dataset and skew every tone prediction.
 */
export function floatDngToSrgb8(image: FloatDngImage): Uint8Array {
  const { width, height, data, calibration } = image;
  const { whiteLevel, blackLevel, asShotNeutral, forwardMatrix } = calibration;

  const range = whiteLevel - blackLevel || 1;
  // As-shot neutral is a divisor: it maps the camera's native response onto a
  // neutral grey. Absent (unusual), leave the channels untouched.
  const wb = asShotNeutral && asShotNeutral.length >= 3 ? asShotNeutral : [1, 1, 1];
  const fm = forwardMatrix;

  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    // 1. Normalize to 0..1 scene-linear and apply the as-shot white balance.
    const c = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const v = (data[i * 3 + ch] - blackLevel) / range;
      c[ch] = v / (wb[ch] || 1);
    }

    // 2. Camera → XYZ(D50) → linear sRGB. Without a forward matrix the camera
    //    values are the best available approximation of sRGB primaries.
    let r: number, g: number, b: number;
    if (fm) {
      const x = fm[0] * c[0] + fm[1] * c[1] + fm[2] * c[2];
      const y = fm[3] * c[0] + fm[4] * c[1] + fm[5] * c[2];
      const z = fm[6] * c[0] + fm[7] * c[1] + fm[8] * c[2];
      r = XYZ_D50_TO_SRGB[0] * x + XYZ_D50_TO_SRGB[1] * y + XYZ_D50_TO_SRGB[2] * z;
      g = XYZ_D50_TO_SRGB[3] * x + XYZ_D50_TO_SRGB[4] * y + XYZ_D50_TO_SRGB[5] * z;
      b = XYZ_D50_TO_SRGB[6] * x + XYZ_D50_TO_SRGB[7] * y + XYZ_D50_TO_SRGB[8] * z;
    } else {
      [r, g, b] = c;
    }

    // 3. Encode. HDR merges legitimately exceed the white point, so clamping is
    //    the highlight-clipping signal the features are meant to see.
    out[i * 3 + 0] = Math.max(0, Math.min(255, Math.round(srgbEncode(Math.max(0, Math.min(1, r))) * 255)));
    out[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(srgbEncode(Math.max(0, Math.min(1, g))) * 255)));
    out[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(srgbEncode(Math.max(0, Math.min(1, b))) * 255)));
  }
  return out;
}

/**
 * Decode a float DNG and return a neutral sRGB raster encoded as PNG.
 *
 * PNG rather than raw pixels so the result drops straight into
 * {@link extractColorFeatures}, which already accepts an encoded buffer — the
 * feature path then stays byte-for-byte the same as for every other file, which
 * is exactly what keeps HDR merges comparable to the rest of the dataset.
 * Returns null when the file is not a float DNG.
 */
export async function renderFloatDngNeutral(
  file: string,
  options: FloatDngOptions = {},
): Promise<Buffer | null> {
  const image = await readFloatDng(file, options);
  if (!image) return null;
  const rgb = floatDngToSrgb8(image);
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), {
    raw: { width: image.width, height: image.height, channels: 3 },
  })
    .png()
    .toBuffer();
}
