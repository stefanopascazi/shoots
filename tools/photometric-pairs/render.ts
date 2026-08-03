/**
 * RAW → one scene-linear reference → N degraded 8-bit variants.
 *
 * The RAW is decoded exactly once. Every variant is then a per-channel
 * multiplication applied to that one linear buffer, which is what an exposure or
 * white-balance error physically *is* — so the variants are colorimetrically
 * exact, and a five-variant run costs one decode instead of five.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildLut, evGain, wbGains } from './wb.js';

/** Extensions `dcraw_emu` will decode. Bayer only — float DNGs are not CFA. */
const RAW_EXT = new Set([
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2',
  '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.raw', '.3fr', '.iiq',
]);

/**
 * Locate `dcraw_emu` without going through the CLI package.
 *
 * This tool is deliberately outside the shipped binary, so it must not depend on
 * the workspace being built. The provisioning layout is stable
 * (`~/.shoots/bin/libraw/<version>/`) and both env overrides the CLI honours work
 * here too, so a plain filesystem lookup is enough.
 */
export function resolveDcraw(): string {
  for (const env of [process.env.SHOOTS_LIBRAW, process.env.SHOOTS_RAW_DEVELOPER]) {
    const v = env?.trim();
    if (v) return v;
  }
  const root = path.join(process.env.SHOOTS_HOME?.trim() || path.join(homedir(), '.shoots'), 'bin', 'libraw');
  if (existsSync(root)) {
    for (const version of readdirSync(root).sort().reverse()) {
      for (const name of ['dcraw_emu.exe', 'dcraw_emu']) {
        const bin = path.join(root, version, name);
        if (existsSync(bin)) return bin;
      }
    }
  }
  throw new Error(
    'dcraw_emu not found. Run `shoots setup` to provision LibRaw, or point SHOOTS_LIBRAW at a binary.',
  );
}

/** Every RAW under `dir`, recursively, in a stable order. */
export async function findRaws(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (RAW_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => reject(new Error(`dcraw_emu failed to start: ${e.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`dcraw_emu exited ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 200)}`)),
    );
  });
}

export interface LinearReference {
  data: Uint16Array;
  width: number;
  height: number;
}

/**
 * Parse dcraw's 16-bit binary PPM.
 *
 * Hand-rolled because sharp cannot be trusted to hand back this data unaltered:
 * its raw pipeline silently reduces a 16-bit linear TIFF to 8 bits (values top
 * out at 255 in 16-bit containers), and `toColourspace('rgb16')` preserves the
 * depth but applies a transfer function — measured 0.238 against dcraw's true
 * 0.0704 on the same file. Either one destroys the linearity every gain here
 * depends on, and the 8-bit path would quantise the shadows *before* a −2 EV
 * label was applied to them. Reading the bytes is fifteen lines and is exact.
 *
 * PPM stores 16-bit samples big-endian regardless of host order (Netpbm spec).
 */
export function parsePpm(buf: Buffer): LinearReference {
  let p = 0;
  const token = (): string => {
    while (p < buf.length && (buf[p]! === 0x20 || buf[p]! === 0x0a || buf[p]! === 0x0d || buf[p]! === 0x09)) p++;
    if (buf[p] === 0x23) { // comment to end of line
      while (p < buf.length && buf[p]! !== 0x0a) p++;
      return token();
    }
    const start = p;
    while (p < buf.length && ![0x20, 0x0a, 0x0d, 0x09].includes(buf[p]!)) p++;
    return buf.toString('ascii', start, p);
  };
  const magic = token();
  if (magic !== 'P6') throw new Error(`expected a P6 PPM, got '${magic}'`);
  const width = Number(token());
  const height = Number(token());
  const maxval = Number(token());
  if (maxval !== 65535) throw new Error(`expected 16-bit PPM (maxval 65535), got ${maxval}`);
  p++; // single whitespace byte before the raster

  const n = width * height * 3;
  const data = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const o = p + i * 2;
    data[i] = (buf[o]! << 8) | buf[o + 1]!;
  }
  return { data, width, height };
}

/**
 * Area-average downscale, in linear light.
 *
 * Averaging pixels is only physically meaningful on linear values, which is the
 * whole reason the resize happens here rather than after the transfer function.
 * A plain box average is the right filter for a large reduction and has no
 * ringing to push a highlight over the clip point.
 */
export function downscale(src: LinearReference, maxEdge: number): LinearReference {
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (scale >= 1) return src;
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const data = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * src.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * src.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / width));
      let r = 0, g = 0, b = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const j = (sy * src.width + sx) * 3;
          r += src.data[j]!; g += src.data[j + 1]!; b += src.data[j + 2]!;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 3;
      data[o] = r / count; data[o + 1] = g / count; data[o + 2] = b / count;
    }
  }
  return { data, width, height };
}

/**
 * Decode one RAW to a scene-linear, as-shot-balanced, downscaled buffer.
 *
 * `-4` is 16-bit linear with auto-brighten off, so the true scene exposure
 * survives — the same reasoning that fixes `-W` in the CLI's neutral baseline
 * (`rawDeveloper.ts`), and here it is load-bearing: an auto-brightened reference
 * would silently undo the exposure error we are about to introduce.
 *
 * `-h` halves the image during demosaic, which is where most of the decode time
 * goes and costs nothing: every feature downstream is a global statistic.
 *
 * Output is PPM rather than TIFF so the raster can be read byte for byte — see
 * {@link parsePpm} for why nothing in this path goes through an image library.
 */
export async function renderReference(bin: string, raw: string, size: number): Promise<LinearReference> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shoots-pairs-'));
  const out = path.join(dir, 'ref.ppm');
  try {
    await run(bin, ['-w', '-4', '-o', '1', '-h', '-Z', out, raw]);
    return downscale(parsePpm(await readFile(out)), size);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface Degradation {
  /** Exposure error in stops. Positive = the variant is brighter than truth. */
  ev: number;
  /** White-balance error in mired, relative to the as-shot render. */
  mired: number;
  /** Green–magenta error. */
  tint: number;
}

/**
 * Apply one degradation to the linear reference and write an 8-bit sRGB JPEG.
 *
 * @returns the fraction of pixels with at least one channel at full scale.
 *
 * That number is recorded per variant because it bounds what the label is worth.
 * Where a channel saturates its mean stops responding to the gain, so the
 * degradation is no longer fully recoverable from the pixels — measured here as
 * 0.2% error in the white-balance ratio below 0.5% clipping against 2.6% above
 * it. The label stays correct; the sample just gets harder, and a consumer that
 * wants to weight or drop those needs to be told which they are rather than
 * discovering it as noise.
 */
export async function writeVariant(
  ref: LinearReference,
  d: Degradation,
  outPath: string,
  quality: number,
): Promise<number> {
  const wb = wbGains(d.mired, d.tint);
  const e = evGain(d.ev);
  const luts = [buildLut(wb[0] * e), buildLut(wb[1] * e), buildLut(wb[2] * e)];
  const px = ref.width * ref.height;
  const rgb = new Uint8Array(px * 3);
  let clipped = 0;
  for (let i = 0; i < px; i++) {
    const j = i * 3;
    const r = (rgb[j] = luts[0]![ref.data[j]!]!);
    const g = (rgb[j + 1] = luts[1]![ref.data[j + 1]!]!);
    const b = (rgb[j + 2] = luts[2]![ref.data[j + 2]!]!);
    if (r === 255 || g === 255 || b === 255) clipped++;
  }
  await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), {
    raw: { width: ref.width, height: ref.height, channels: 3 },
  })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toFile(outPath);
  return clipped / px;
}

/** Whether a path is a readable directory. */
export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
