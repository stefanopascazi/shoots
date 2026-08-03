/**
 * photometric-pairs — build a self-supervised training set for a photometric encoder.
 *
 * Deliberately outside the CLI: this produces research data, not something a
 * photographer runs, and it must keep working without the workspace being built.
 *
 *   bun tools/photometric-pairs/index.ts --in <raw-dir> --out <dataset-dir>
 *
 * For every RAW under `--in` it emits N degraded renders with the degradation
 * recorded as the label. No edit, no XMP and no catalog is ever read: an edited
 * RAW and an untouched one are the same input here, which is what makes a whole
 * archive usable rather than only its edited part.
 *
 * The label is the *error*, not the correct value — "this frame is 1.3 stops
 * under and 40 mired too warm relative to as-shot". That is deliberately the same
 * quantity the develop predictor's targets are encoded in (`decodeDelta` is
 * relative to as-shot too), so an encoder trained here produces a feature the
 * existing ridge can consume without a change of units.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import path from 'node:path';
import { ANCHOR_KELVIN, kelvinToMired, miredToKelvin } from './wb.js';
import { findRaws, isDir, renderReference, resolveDcraw, writeVariant, type Degradation } from './render.js';

interface Options {
  in: string;
  out: string;
  variants: number;
  size: number;
  quality: number;
  ev: number;
  mired: number;
  tint: number;
  limit: number;
  jobs: number;
  seed: number;
  force: boolean;
}

const DEFAULTS = {
  variants: 5,
  size: 512,
  quality: 92,
  ev: 2,
  mired: 60,
  tint: 20,
  limit: 0,
  seed: 1,
};

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number): number => {
    const v = get(name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} expects a number, got '${v}'`);
    return n;
  };
  const input = get('in');
  const out = get('out');
  if (!input || !out) {
    throw new Error(
      'usage: bun tools/photometric-pairs/index.ts --in <raw-dir> --out <dataset-dir> ' +
        '[--variants 5] [--size 512] [--quality 92] [--ev 2] [--mired 60] [--tint 20] ' +
        '[--limit 0] [--jobs N] [--seed 1] [--force]',
    );
  }
  return {
    in: path.resolve(input),
    out: path.resolve(out),
    variants: num('variants', DEFAULTS.variants),
    size: num('size', DEFAULTS.size),
    quality: num('quality', DEFAULTS.quality),
    ev: num('ev', DEFAULTS.ev),
    mired: num('mired', DEFAULTS.mired),
    tint: num('tint', DEFAULTS.tint),
    limit: num('limit', DEFAULTS.limit),
    jobs: num('jobs', Math.max(1, Math.floor(cpus().length / 2))),
    seed: num('seed', DEFAULTS.seed),
    force: argv.includes('--force'),
  };
}

/** mulberry32 — small, fast, and identical across runs, which is the point. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stable id for one source file.
 *
 * Hashed from the path *relative to the input root*, so moving the archive or
 * re-running against a copy reproduces the same dataset — and so the per-file
 * seed does not shift when files are added.
 */
const idFor = (rel: string): string => createHash('sha1').update(rel).digest('hex').slice(0, 16);

/**
 * The degradations for one file: variant 0 is always the untouched reference.
 *
 * Keeping a zero variant costs one image per RAW and buys the thing that is
 * otherwise impossible to check — that the pipeline's idea of "no error" and the
 * encoder's agree. A model that cannot score the clean frame at zero is wrong in
 * a way no amount of held-out MAE will reveal.
 */
function degradations(id: string, opts: Options): Degradation[] {
  const r = rng(Number.parseInt(id.slice(0, 8), 16) ^ opts.seed);
  const spread = (range: number): number => (r() * 2 - 1) * range;
  const out: Degradation[] = [{ ev: 0, mired: 0, tint: 0 }];
  for (let i = 1; i < opts.variants; i++) {
    out.push({ ev: spread(opts.ev), mired: spread(opts.mired), tint: spread(opts.tint) });
  }
  return out;
}

const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!(await isDir(opts.in))) throw new Error(`--in is not a directory: ${opts.in}`);

  const bin = resolveDcraw();
  const imagesDir = path.join(opts.out, 'images');
  await mkdir(imagesDir, { recursive: true });

  let raws = await findRaws(opts.in);
  if (opts.limit > 0) raws = raws.slice(0, opts.limit);
  if (raws.length === 0) throw new Error(`no RAW files found under ${opts.in}`);

  console.log(
    `${raws.length} RAW · ${opts.variants} variants · ${opts.size}px · jobs ${opts.jobs}\n` +
      `  dcraw_emu  ${bin}\n` +
      `  ranges     ±${opts.ev} EV · ±${opts.mired} mired · ±${opts.tint} tint\n` +
      `  out        ${opts.out}`,
  );

  const manifest: string[] = [];
  let done = 0;
  let rendered = 0;
  let skipped = 0;
  let failed = 0;
  const started = Date.now();

  // Metadata is derived from (seed, relative path) alone, so a resumed run can
  // rebuild every manifest line without touching the RAW — only the missing
  // images are actually decoded. That is what makes this safe to interrupt.
  const work = async (raw: string): Promise<void> => {
    const rel = path.relative(opts.in, raw).replaceAll('\\', '/');
    const id = idFor(rel);
    const plan = degradations(id, opts);
    const targets = plan.map((d, v) => ({ d, v, file: path.join(imagesDir, `${id}_${v}.jpg`) }));

    for (const { d, v, file } of targets) {
      manifest.push(
        JSON.stringify({
          id: `${id}_${v}`,
          source: rel,
          variant: v,
          ev: round(d.ev, 4),
          mired: round(d.mired, 3),
          tint: round(d.tint, 3),
          // The mired shift stated as the Kelvin pair it was derived from, so a
          // consumer that wants ACR's units does not have to re-derive the anchor.
          kelvinFrom: ANCHOR_KELVIN,
          kelvinTo: round(miredToKelvin(kelvinToMired(ANCHOR_KELVIN) + d.mired), 1),
          image: path.relative(opts.out, file).replaceAll('\\', '/'),
        }),
      );
    }

    const missing = targets.filter((t) => opts.force || !existsSync(t.file));
    if (missing.length === 0) {
      skipped++;
      return;
    }
    try {
      const ref = await renderReference(bin, raw, opts.size);
      for (const { d, file } of missing) await writeVariant(ref, d, file, opts.quality);
      rendered++;
    } catch (e) {
      failed++;
      console.error(`  ! ${rel}: ${(e as Error).message}`);
    }
  };

  // Fixed-size worker pool over a shared cursor: one decode at a time per worker,
  // which is what keeps peak memory flat regardless of how big the archive is.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(opts.jobs, raws.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= raws.length) return;
      await work(raws[i]!);
      done++;
      if (done % 25 === 0 || done === raws.length) {
        const pct = ((done / raws.length) * 100).toFixed(1);
        const rate = done / ((Date.now() - started) / 1000);
        const eta = rate > 0 ? Math.round((raws.length - done) / rate) : 0;
        process.stdout.write(`\r  ${done}/${raws.length} (${pct}%) · ${rate.toFixed(1)} raw/s · eta ${eta}s   `);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write('\n');

  const manifestPath = path.join(opts.out, 'pairs.jsonl');
  await writeFile(manifestPath, `${manifest.join('\n')}\n`, 'utf8');
  await writeFile(
    path.join(opts.out, 'pairs.meta.json'),
    `${JSON.stringify(
      {
        generator: 'photometric-pairs',
        createdAt: new Date().toISOString(),
        source: opts.in,
        sources: raws.length,
        samples: manifest.length,
        variants: opts.variants,
        size: opts.size,
        seed: opts.seed,
        ranges: { ev: opts.ev, mired: opts.mired, tint: opts.tint },
        anchorKelvin: ANCHOR_KELVIN,
        dcraw: bin,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(
    `\n${manifest.length} samples → ${manifestPath}\n` +
      `  rendered ${rendered} · skipped ${skipped} · failed ${failed} · ${Math.round((Date.now() - started) / 1000)}s`,
  );
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
