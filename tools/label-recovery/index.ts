/**
 * label-recovery — Phase 2 of ENCODER-PLAN.md, the kill-switch experiment.
 *
 *   bun tools/label-recovery/index.ts --dataset test/datapairs
 *
 * Fits a ridge from the **existing 50 photometric features** to the synthetic
 * degradation labels and reports how much of each it recovers held out.
 *
 * The question: is the develop predictor's representation the bottleneck, or is
 * it the regressor? If the features the tool already computes can say "this
 * frame is 1.3 stops under and 40 mired too warm", then a learned encoder has
 * nothing to add for those quantities and Phase 3 is falsified for a day's work
 * instead of a month's. If they cannot, the gap is measured in the units the
 * encoder will be scored in.
 *
 * The task is well posed and not trivial. Mean luminance alone cannot solve it:
 * a genuinely dark scene at 0 EV and a bright one at −2 EV have the same mean, so
 * recovering the label needs a prior over what correct photographs look like.
 *
 * Two things this gets right, both of which would otherwise inflate the answer:
 *
 *  1. **Folds hold out whole source scenes.** The five variants of one photograph
 *     differ only by the perturbation; split across train and test, the fit has
 *     already seen the answer.
 *  2. **λ is chosen inside each outer fold.** A λ picked on the split it is then
 *     scored on flatters the score, and here a flattered score argues for
 *     *stopping* — the expensive direction to be wrong in.
 */
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { buildNormalEquations, solveRidge } from '../../packages/cli/src/develop/train/regress.js';
import { COLOR_FEATURE_NAMES, ensureFeatures, readCache } from './features.js';

/**
 * Shrinkage per sample, as in the develop trainer — but extended far below its
 * floor. That grid stops at 0.1 because the develop fit runs at n≈500 with a
 * wide feature vector; here n is 25k against 50 columns, so the honest optimum
 * is near-zero shrinkage and a grid bottoming out at 0.1 would silently
 * understate every score by reporting the best *available* λ rather than the
 * best one.
 */
const LAMBDA_GRID = [0.0001, 0.001, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100];
const LABELS = ['ev', 'mired', 'tint'] as const;
type Label = (typeof LABELS)[number];

interface Sample {
  id: string;
  source: string;
  variant: number;
  clip: number;
  y: Record<Label, number>;
  x: number[];
}

interface Options {
  dataset: string;
  maxClip: number;
  folds: number;
  shuffles: number;
  jobs: number;
  includeZero: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (n: string, d: number): number => {
    const v = get(n);
    return v === undefined ? d : Number(v);
  };
  const dataset = get('dataset');
  if (!dataset) {
    throw new Error(
      'usage: bun tools/label-recovery/index.ts --dataset <photometric-pairs-dir> ' +
        '[--max-clip 0.05] [--folds 5] [--shuffles 5] [--jobs N] [--include-zero]',
    );
  }
  return {
    dataset: path.resolve(dataset),
    maxClip: num('max-clip', 0.05),
    folds: num('folds', 5),
    shuffles: num('shuffles', 5),
    jobs: num('jobs', Math.max(1, cpus().length - 1)),
    // Variant 0 carries the label (0,0,0) exactly. It is a real sample — a
    // correctly exposed frame — but it is a fifth of the set sitting on one
    // point, so it is reported separately rather than silently shaping the fit.
    includeZero: argv.includes('--include-zero'),
  };
}

/** Deterministic shuffle, so a re-run reproduces the same fold assignment. */
function shuffled<T>(items: T[], seed: number): T[] {
  let s = (seed * 7919 + 13) >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface ColStats { mean: number[]; std: number[] }

function columnStats(rows: number[][]): ColStats {
  const d = rows[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j]! += r[j]!;
  for (let j = 0; j < d; j++) mean[j]! /= Math.max(1, rows.length);
  const std = new Array<number>(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) std[j]! += (r[j]! - mean[j]!) ** 2;
  // A constant column would divide by zero; 1 leaves it constant, and centering
  // in the normal equations then kills it.
  for (let j = 0; j < d; j++) std[j]! = Math.sqrt(std[j]! / Math.max(1, rows.length)) || 1;
  return { mean, std };
}

const standardize = (x: number[], s: ColStats): number[] => x.map((v, j) => (v - s.mean[j]!) / s.std[j]!);

/** Held-out MAE of a ridge at one λ, plus the mean-baseline MAE. */
function scoreFold(
  train: Sample[],
  test: Sample[],
  label: Label,
  lambda: number,
): { model: number; base: number } {
  const fx = columnStats(train.map((s) => s.x));
  const X = train.map((s) => standardize(s.x, fx));
  const ybar = train.reduce((a, s) => a + s.y[label], 0) / train.length;
  const yspread = Math.sqrt(train.reduce((a, s) => a + (s.y[label] - ybar) ** 2, 0) / train.length) || 1;
  const Y = train.map((s) => [(s.y[label] - ybar) / yspread]);

  const fit = solveRidge(buildNormalEquations(X, Y), lambda);
  const w = fit.weights[0]!;
  const b = fit.bias[0]!;

  let model = 0;
  let base = 0;
  for (const s of test) {
    const xs = standardize(s.x, fx);
    let dot = b;
    for (let j = 0; j < xs.length; j++) dot += w[j]! * xs[j]!;
    model += Math.abs(dot * yspread + ybar - s.y[label]);
    base += Math.abs(ybar - s.y[label]);
  }
  return { model: model / test.length, base: base / test.length };
}

/** One shuffle: folds over whole scenes, λ re-selected inside each outer fold. */
function oneShuffle(samples: Sample[], label: Label, opts: Options, seed: number): { skill: number; lambdas: number[] } {
  const scenes = shuffled([...new Set(samples.map((s) => s.source))], seed);
  const foldOf = new Map(scenes.map((s, i) => [s, i % opts.folds]));
  let model = 0;
  let base = 0;
  const lambdas: number[] = [];

  for (let f = 0; f < opts.folds; f++) {
    const train = samples.filter((s) => foldOf.get(s.source) !== f);
    const test = samples.filter((s) => foldOf.get(s.source) === f);
    if (train.length < 10 || test.length === 0) continue;

    // Inner selection, on the training scenes only.
    const innerScenes = shuffled([...new Set(train.map((s) => s.source))], seed + 1000 + f);
    const innerOf = new Map(innerScenes.map((s, i) => [s, i % opts.folds]));
    let best = { lambda: LAMBDA_GRID[0]!, mae: Infinity };
    for (const lambda of LAMBDA_GRID) {
      let acc = 0;
      let n = 0;
      for (let g = 0; g < opts.folds; g++) {
        const itr = train.filter((s) => innerOf.get(s.source) !== g);
        const ite = train.filter((s) => innerOf.get(s.source) === g);
        if (itr.length < 10 || ite.length === 0) continue;
        acc += scoreFold(itr, ite, label, lambda).model * ite.length;
        n += ite.length;
      }
      if (n > 0 && acc / n < best.mae) best = { lambda, mae: acc / n };
    }
    lambdas.push(best.lambda);

    const s = scoreFold(train, test, label, best.lambda);
    model += s.model * test.length;
    base += s.base * test.length;
  }
  return { skill: base > 0 ? 1 - model / base : 0, lambdas };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readFileSync(path.join(opts.dataset, 'pairs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { id: string; source: string; variant: number; clip: number; ev: number; mired: number; tint: number; image: string });

  const kept = manifest.filter((r) => r.clip <= opts.maxClip && (opts.includeZero || r.variant !== 0));
  console.log(
    `${manifest.length} samples · ${kept.length} kept (clip ≤ ${opts.maxClip}` +
      `${opts.includeZero ? '' : ', variant 0 excluded'}) · ${new Set(kept.map((r) => r.source)).size} scenes`,
  );

  const cacheFile = path.join(opts.dataset, 'features.jsonl');
  const cache = await readCache(cacheFile);
  const before = cache.size;
  await ensureFeatures(opts.dataset, cacheFile, kept, cache, {
    jobs: opts.jobs,
    onProgress: (d, t) => process.stdout.write(`\r  features ${d}/${t}   `),
  });
  if (cache.size > before) process.stdout.write('\n');
  console.log(`  ${cache.size} feature vectors (${COLOR_FEATURE_NAMES.length} dims)`);

  const samples: Sample[] = [];
  for (const r of kept) {
    const x = cache.get(r.id);
    if (x) samples.push({ id: r.id, source: r.source, variant: r.variant, clip: r.clip, y: { ev: r.ev, mired: r.mired, tint: r.tint }, x });
  }
  if (samples.length < 100) throw new Error(`only ${samples.length} usable samples`);
  console.log(`  ${samples.length} usable\n`);

  console.log('  label       skill      ±shuffle    λ (mode)   baseline MAE');
  for (const label of LABELS) {
    const runs = Array.from({ length: opts.shuffles }, (_, i) => oneShuffle(samples, label, opts, i + 1));
    const skills = runs.map((r) => r.skill);
    const mean = skills.reduce((a, b) => a + b, 0) / skills.length;
    const sd = Math.sqrt(skills.reduce((a, v) => a + (v - mean) ** 2, 0) / skills.length);
    const all = runs.flatMap((r) => r.lambdas);
    const mode = [...new Set(all)].sort((a, b) => all.filter((v) => v === b).length - all.filter((v) => v === a).length)[0];
    const ybar = samples.reduce((a, s) => a + s.y[label], 0) / samples.length;
    const baseMae = samples.reduce((a, s) => a + Math.abs(s.y[label] - ybar), 0) / samples.length;
    console.log(
      `  ${label.padEnd(10)} ${mean.toFixed(4).padStart(7)}    ${sd.toFixed(4).padStart(7)}   ${String(mode).padStart(7)}   ${baseMae.toFixed(3).padStart(9)}`,
    );
  }

  console.log(
    '\n  Reading this: skill is 1 − MAE_ridge / MAE_mean, scenes held out.\n' +
      '  High  → the existing features already carry it; an encoder adds nothing here (Phase 3 falsified for this label).\n' +
      '  Low   → the gap is real and this is the number Phase 3 has to beat.',
  );
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
