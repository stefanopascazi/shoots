/**
 * Decode once, re-render on every slider move.
 *
 * A RAW decode is ~800ms for a 35MB CR3; applying a develop setting to the
 * decoded scene-linear buffer is ~20ms at 900px. So the decode happens once per
 * preview frame when the screen opens, and every subsequent move is table
 * lookups over a buffer already in memory. Five frames therefore cost about four
 * seconds to set up and ~125ms to re-render together, which is the difference
 * between a review screen and a batch job.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeJpeg } from '@shoots/imaging';
import { resolveRawDeveloper } from '../../rawDeveloper.js';
import { buildLut, render, wbGains, type LinearImage, type ToneSettings } from './pipeline.js';
import { CURVE_KNOTS, sampleCurve } from '../develop/schema.js';
import type { AsShotMeta } from '../develop/schema.js';

/**
 * Parse dcraw's 16-bit binary PPM.
 *
 * Read directly rather than through an image library: sharp silently reduces a
 * 16-bit linear raster to 8 bits on its raw path, and its 16-bit colourspace
 * conversion applies a transfer function — either one destroys the linearity
 * every gain here depends on. PPM stores 16-bit samples big-endian.
 */
function parsePpm(buf: Buffer): LinearImage {
  let p = 0;
  const token = (): string => {
    while (p < buf.length && [0x20, 0x0a, 0x0d, 0x09].includes(buf[p]!)) p++;
    if (buf[p] === 0x23) {
      while (p < buf.length && buf[p]! !== 0x0a) p++;
      return token();
    }
    const start = p;
    while (p < buf.length && ![0x20, 0x0a, 0x0d, 0x09].includes(buf[p]!)) p++;
    return buf.toString('ascii', start, p);
  };
  if (token() !== 'P6') throw new Error('expected a P6 PPM from the RAW developer');
  const width = Number(token());
  const height = Number(token());
  if (Number(token()) !== 65535) throw new Error('expected a 16-bit PPM');
  p++;
  const n = width * height * 3;
  const data = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const o = p + i * 2;
    data[i] = (buf[o]! << 8) | buf[o + 1]!;
  }
  return { data, width, height };
}

/** Area-average downscale, in linear light — the only place averaging is meaningful. */
function downscale(src: LinearImage, maxEdge: number): LinearImage {
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
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const j = (sy * src.width + sx) * 3;
          r += src.data[j]!;
          g += src.data[j + 1]!;
          b += src.data[j + 2]!;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 3;
      data[o] = r / count;
      data[o + 1] = g / count;
      data[o + 2] = b / count;
    }
  }
  return { data, width, height };
}

/** Decode one RAW to a scene-linear, as-shot-balanced, downscaled buffer. */
export async function decode(rawPath: string, size: number): Promise<LinearImage> {
  const dev = resolveRawDeveloper();
  if (!dev) throw new Error('no RAW developer available — run `shoots setup`');
  const dir = await mkdtemp(path.join(tmpdir(), 'shoots-review-'));
  const out = path.join(dir, 'ref.ppm');
  try {
    await new Promise<void>((resolve, reject) => {
      // `-4` is 16-bit linear with auto-brighten off, so the true scene exposure
      // survives into the preview; anything else would hide the very error the
      // exposure slider exists to correct.
      const child = spawn(dev.command, ['-w', '-4', '-o', '1', '-h', '-Z', out, rawPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const err: Buffer[] = [];
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', (e) => reject(new Error(`RAW developer failed to start: ${e.message}`)));
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString('utf8').trim().slice(0, 200))),
      );
    });
    return downscale(parsePpm(await readFile(out)), size);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Turn a predicted develop record into the settings the pipeline understands. */
export function toneOf(develop: Record<string, number>): ToneSettings {
  const knots: [number, number][] = CURVE_KNOTS.map((k) => [k, develop[`ToneCurvePoint${k}`] ?? k]);
  // An identity curve costs a lookup per pixel and changes nothing; drop it.
  const moved = knots.some(([x, y]) => Math.abs(x - y) > 0.5);
  return {
    exposure: develop.Exposure2012 ?? 0,
    contrast: develop.Contrast2012 ?? 0,
    highlights: develop.Highlights2012 ?? 0,
    shadows: develop.Shadows2012 ?? 0,
    whites: develop.Whites2012 ?? 0,
    blacks: develop.Blacks2012 ?? 0,
    dehaze: develop.Dehaze ?? 0,
    curve: moved ? knots : [],
  };
}

/** Render one decoded frame with one predicted edit, as a JPEG buffer. */
export async function renderPreview(
  image: LinearImage,
  develop: Record<string, number>,
  meta: AsShotMeta,
  quality = 82,
): Promise<Buffer> {
  const asShot = meta.tempAsShot && meta.tempAsShot > 0 ? meta.tempAsShot : 5500;
  const chosen = develop.Temperature && develop.Temperature > 0 ? develop.Temperature : asShot;
  const gains = wbGains(asShot, chosen, develop.Tint ?? 0);
  const tone = toneOf(develop);
  const luts: [Uint8Array, Uint8Array, Uint8Array] = [
    buildLut(tone, gains[0]),
    buildLut(tone, gains[1]),
    buildLut(tone, gains[2]),
  ];
  const rgb = render(image, luts, (develop.Saturation ?? 0) + (develop.Dehaze ?? 0) * 0.3, develop.Vibrance ?? 0);
  return encodeJpeg(rgb, image.width, image.height, quality);
}

export { sampleCurve };
