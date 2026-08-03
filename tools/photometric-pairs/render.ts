/**
 * RAW → one scene-linear reference → N degraded 8-bit variants.
 *
 * The RAW is decoded exactly once. Every variant is then a per-channel
 * multiplication applied to that one linear buffer, which is what an exposure or
 * white-balance error physically *is* — so the variants are colorimetrically
 * exact, and a five-variant run costs one decode instead of five.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
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
 * Decode one RAW to a scene-linear, as-shot-balanced, downscaled buffer.
 *
 * `-4` is 16-bit linear with auto-brighten off, so the true scene exposure
 * survives — the same reasoning that fixes `-W` in the CLI's neutral baseline
 * (`rawDeveloper.ts`), and here it is load-bearing: an auto-brightened reference
 * would silently undo the exposure error we are about to introduce.
 *
 * `-h` halves the image during demosaic, which is where most of the decode time
 * goes and costs nothing: every feature downstream is a global statistic.
 * The final resize happens in linear light, which is the only place averaging
 * pixels is physically meaningful.
 */
export async function renderReference(bin: string, raw: string, size: number): Promise<LinearReference> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shoots-pairs-'));
  const out = path.join(dir, 'ref.tiff');
  try {
    await run(bin, ['-w', '-4', '-o', '1', '-h', '-T', '-Z', out, raw]);
    const { data, info } = await sharp(out)
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .raw({ depth: 'ushort' })
      .toBuffer({ resolveWithObject: true });
    // Node may hand back a pooled Buffer at an odd offset, which a Uint16Array
    // view cannot straddle. Only small images can land in the pool, so the copy
    // is never paid on a real run.
    const aligned = data.byteOffset % 2 === 0 ? data : Buffer.from(data);
    return {
      data: new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2),
      width: info.width,
      height: info.height,
    };
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

/** Apply one degradation to the linear reference and write an 8-bit sRGB JPEG. */
export async function writeVariant(
  ref: LinearReference,
  d: Degradation,
  outPath: string,
  quality: number,
): Promise<void> {
  const wb = wbGains(d.mired, d.tint);
  const e = evGain(d.ev);
  const luts = [buildLut(wb[0] * e), buildLut(wb[1] * e), buildLut(wb[2] * e)];
  const px = ref.width * ref.height;
  const rgb = new Uint8Array(px * 3);
  for (let i = 0; i < px; i++) {
    const j = i * 3;
    rgb[j] = luts[0]![ref.data[j]!]!;
    rgb[j + 1] = luts[1]![ref.data[j + 1]!]!;
    rgb[j + 2] = luts[2]![ref.data[j + 2]!]!;
  }
  await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), {
    raw: { width: ref.width, height: ref.height, channels: 3 },
  })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toFile(outPath);
}

/** Whether a path is a readable directory. */
export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
