/**
 * External RAW-developer bridge for the neutral develop baseline.
 *
 * The develop predictor needs a colorimetrically consistent, camera-INDEPENDENT
 * neutral render of each RAW (see the "baseline" discussion in the plan): the
 * camera's embedded JPEG bakes in a per-model picture style that pollutes the
 * photometric features. A stand-alone RAW developer (LibRaw `dcraw_emu`,
 * RawTherapee-cli, darktable-cli…) demosaics with standard color science instead.
 *
 * We deliberately keep this editor-agnostic and pluggable: the binary and its
 * argument template come from the environment, so the user can validate the lever
 * with a locally installed developer before we invest in `~/.shoots` provisioning
 * (the same pattern used for exiftool). The template uses `{in}` / `{out}`
 * placeholders, substituted as single argv tokens (paths with spaces are safe).
 *
 * Neutral defaults target LibRaw's `dcraw_emu`:
 *   -w  use camera white balance (as-shot reference)
 *   -W  NO auto-brighten — preserves the true scene exposure (critical: this is
 *       what lets the model predict the photographer's exposure correction)
 *   -o 1  sRGB output color   -q 0  fast bilinear demosaic (features are robust)
 *   -T  TIFF output           -Z {out}  explicit output path
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_ARGS = '-w -W -o 1 -q 0 -T -Z {out} {in}';

export interface RawDeveloper {
  command: string;
  argsTemplate: string;
}

/** Resolve the configured external developer, or null when unset. */
export function resolveRawDeveloper(): RawDeveloper | null {
  const command = process.env.SHOOTS_RAW_DEVELOPER?.trim();
  if (!command) return null;
  return { command, argsTemplate: process.env.SHOOTS_RAW_DEVELOPER_ARGS?.trim() || DEFAULT_ARGS };
}

function buildArgs(template: string, inPath: string, outPath: string): string[] {
  return template
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((tok) => tok.replace('{in}', inPath).replace('{out}', outPath));
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

function runDeveloper(dev: RawDeveloper, rawPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(dev.command, buildArgs(dev.argsTemplate, rawPath, outPath), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(`raw developer '${dev.command}' failed to start (${e.code ?? e.message}); check SHOOTS_RAW_DEVELOPER`)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`raw developer exited ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`));
    });
  });
}

/**
 * Render a RAW to a neutral image in a temp dir, hand its path to `fn`, then clean
 * up. If the developer ignores `{out}` and writes next to the input instead (some
 * dcraw builds), we locate that sibling output and use it.
 */
export async function withNeutralRender<T>(
  dev: RawDeveloper,
  rawPath: string,
  fn: (renderedPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shoots-raw-'));
  const out = path.join(dir, 'baseline.tiff');
  const siblings: string[] = [];
  try {
    await runDeveloper(dev, rawPath, out);
    if (await exists(out)) return await fn(out);

    // Fallback: developer wrote beside the input (e.g. <name>.tiff / .ppm).
    const base = path.join(path.dirname(rawPath), path.parse(rawPath).name);
    for (const ext of ['.tiff', '.tif', '.ppm', '.TIFF', '.PPM']) {
      const cand = base + ext;
      if (await exists(cand)) {
        siblings.push(cand);
        return await fn(cand);
      }
    }
    throw new Error(`raw developer produced no output for ${path.basename(rawPath)} (expected ${out})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    for (const s of siblings) await rm(s, { force: true });
  }
}
