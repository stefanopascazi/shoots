/**
 * bw-transfer — can the B&W frame head borrow the colour branch's evidence?
 *
 *   bun tools/bw-transfer/index.ts --data train_v2.jsonl
 *
 * `BASELINE.md` reads B&W within-shoot skill at −0.0021: the branch predicts a
 * per-shoot level and nothing per-frame. 125 photographs over 32 shoots, of which
 * only 11 carry four frames or more, is not much to learn per-frame behaviour
 * from — the colour branch has 428 over 32.
 *
 * ## The hypothesis, and why it is not obviously wrong
 *
 * The two treatments want *different numbers*. Inside the 16 shoots that carry
 * both, the photographer gives the B&W frames Shadows −31 against the colour
 * ones, Highlights +16, Blacks −12. A B&W conversion is not the colour edit plus
 * a constant.
 *
 * But the frame head does not predict the number. It predicts the **departure
 * from this shoot's own level**, and that subtracts exactly the difference above.
 * The question it answers — "this frame is a stop brighter than its neighbours,
 * how much less exposure does it want" — may well have one answer across both
 * treatments. If it does, the B&W frame head can be fitted on 553 photographs
 * instead of 125.
 *
 * ## What is measured
 *
 * Per shared parameter, scored on **B&W frames only**, whole shoots held out:
 *
 *   A  fitted on B&W deviations alone        — what ships today
 *   B  fitted on colour + B&W deviations      — the hypothesis
 *
 * against the baseline a gated frame head emits: no per-frame modulation at all.
 * That is the same baseline `withinSessionSkill` uses, so the numbers here are
 * comparable to the ones in `BASELINE.md`.
 *
 * Shrinkage is re-selected inside every outer fold, for each arm separately.
 * Without that the comparison is worthless: the pooled arm gets 400 extra rows
 * and overfits less for that reason alone, which measures nothing about transfer.
 * This has no gate and no de-shrinking, so its absolute numbers sit below the
 * shipped model's; the column to read is the change between the two arms.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { baseFeatures } from '../../packages/cli/src/develop/develop/assemble.js';
import { DEVELOP_PARAMS, paramsForTreatment, type Treatment } from '../../packages/cli/src/develop/develop/schema.js';
import { targetDeltas } from '../../packages/cli/src/develop/develop/assemble.js';
import { fitRidge, foldsByGroup, mean, sd } from '../lib/fit.js';

/**
 * Shrinkage grid, selected inside every outer fold.
 *
 * Not optional here. At a fixed lambda the two arms are not comparable: the
 * pooled fit gets 402 extra rows, so it overfits less for that reason alone and
 * "more data regularizes an overfit ridge" is not the question. Choosing the
 * shrinkage each arm wants is what leaves only the transfer.
 */
const LAMBDA_GRID = [0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300];

interface Options {
  data: string;
  folds: number;
  shuffles: number;
  minFrames: number;
}

function parseArgs(argv: string[]): Options {
  const get = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const data = get('data');
  if (!data) {
    throw new Error(
      'usage: bun tools/bw-transfer/index.ts --data <train.jsonl> ' +
        '[--folds 5] [--shuffles 20] [--min-frames 4]',
    );
  }
  return {
    data: path.resolve(data),
    folds: Number(get('folds') ?? 5),
    shuffles: Number(get('shuffles') ?? 20),
    minFrames: Number(get('min-frames') ?? 4),
  };
}

const sessionOf = (file: string): string => file.split(/[\\/]/).slice(0, -1).join('/').toLowerCase();

/** Shared parameters only: a GrayMixer has no colour counterpart to borrow from. */
const SHARED = DEVELOP_PARAMS.filter((p) => p.branch === 'shared');

interface Row {
  session: string;
  treatment: Treatment;
  x: number[];
  y: number[];
}

/** Subtract the group mean, column by column — the frame head's whole input. */
function deviations(rows: Row[]): { dx: number[][]; dy: number[][] } {
  const byGroup = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const g = `${rows[i]!.treatment}|${rows[i]!.session}`;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(i);
  }
  const dx = rows.map((r) => [...r.x]);
  const dy = rows.map((r) => [...r.y]);
  for (const idx of byGroup.values()) {
    for (let j = 0; j < rows[0]!.x.length; j++) {
      const m = mean(idx.map((i) => rows[i]!.x[j]!));
      for (const i of idx) dx[i]![j]! -= m;
    }
    for (let k = 0; k < rows[0]!.y.length; k++) {
      const m = mean(idx.map((i) => rows[i]!.y[k]!));
      for (const i of idx) dy[i]![k]! -= m;
    }
  }
  return { dx, dy };
}

/**
 * Shrinkage chosen on the training rows only, by an inner split over shoots.
 *
 * A lambda picked on the split it is then scored on flatters the score, and here
 * a flattered score argues for *building* something — the expensive direction to
 * be wrong in.
 */
function selectLambda(
  dx: number[][],
  dy: number[][],
  k: number,
  train: number[],
  _keys: string[],
  rows: Row[],
  folds: number,
  seed: number,
): number {
  const groups = train.map((i) => `${rows[i]!.treatment}|${rows[i]!.session}`);
  const foldOf = foldsByGroup(groups, folds, seed + 977);
  let best = LAMBDA_GRID[0]!;
  let bestErr = Infinity;
  for (const lambda of LAMBDA_GRID) {
    let err = 0;
    let n = 0;
    for (let f = 0; f < folds; f++) {
      const tr = train.filter((i) => foldOf.get(`${rows[i]!.treatment}|${rows[i]!.session}`) !== f);
      const te = train.filter((i) => foldOf.get(`${rows[i]!.treatment}|${rows[i]!.session}`) === f);
      if (te.length === 0 || tr.length < 20) continue;
      const fit = fitRidge(tr.map((i) => dx[i]!), tr.map((i) => dy[i]![k]!), lambda);
      for (const i of te) { err += Math.abs(fit.predict(dx[i]!) - dy[i]![k]!); n++; }
    }
    if (n > 0 && err / n < bestErr) { bestErr = err / n; best = lambda; }
  }
  return best;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  const rows: Row[] = [];
  for (const line of readFileSync(opts.data, 'utf8').trim().split('\n')) {
    const r = JSON.parse(line) as any;
    if (r.edited === false || !r.file || !r.embedding?.length || !r.features?.length) continue;
    const treatment = (r.treatment === 'bw' ? 'bw' : 'color') as Treatment;
    // The embedding is deliberately dropped, not merely unused: `featureSets.ts`
    // masks it off for every tone and white-balance parameter, and BASELINE.md
    // records raw 512-dim CLIP at n≈500 costing more than dropping it. Passing an
    // empty embedding leaves colour + as-shot, which is what those frame heads
    // actually consume.
    rows.push({
      session: sessionOf(r.file),
      treatment,
      x: baseFeatures([], r.features, r.asShot),
      y: targetDeltas(SHARED, r.develop ?? {}, r.asShot),
    });
  }

  // Shoots with too few frames carry no within-shoot question at all: one frame
  // deviates from itself by nothing, and two deviate by mirror images.
  const counts = new Map<string, number>();
  for (const r of rows) {
    const g = `${r.treatment}|${r.session}`;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const usable = rows.filter((r) => (counts.get(`${r.treatment}|${r.session}`) ?? 0) >= opts.minFrames);
  const bwCount = usable.filter((r) => r.treatment === 'bw').length;
  const bwShoots = new Set(usable.filter((r) => r.treatment === 'bw').map((r) => r.session));
  console.log(
    `${rows.length} edited → ${usable.length} in shoots of ${opts.minFrames}+ ` +
      `(${bwCount} B&W over ${bwShoots.size} shoots, ${usable.length - bwCount} colour)\n`,
  );
  if (bwCount < 40) throw new Error('too few usable B&W frames');

  const { dx, dy } = deviations(usable);
  const bwIdx = usable.map((_, i) => i).filter((i) => usable[i]!.treatment === 'bw');
  const colIdx = usable.map((_, i) => i).filter((i) => usable[i]!.treatment === 'color');
  const keys = bwIdx.map((i) => usable[i]!.session);

  console.log('  parameter            B&W only   pooled   ±shuffle   change   true sd');
  const bwParams = new Set(paramsForTreatment('bw').map((p) => p.key));
  for (let k = 0; k < SHARED.length; k++) {
    if (!bwParams.has(SHARED[k]!.key)) continue;
    const truth = bwIdx.map((i) => dy[i]![k]!);
    if (sd(truth) < 1e-9) continue;

    const scores: Record<'own' | 'pooled', number[]> = { own: [], pooled: [] };
    for (let s = 0; s < opts.shuffles; s++) {
      const foldOf = foldsByGroup(keys, opts.folds, s + 1);
      const acc: Record<'own' | 'pooled', { model: number; base: number }> = {
        own: { model: 0, base: 0 },
        pooled: { model: 0, base: 0 },
      };
      for (let f = 0; f < opts.folds; f++) {
        const te = bwIdx.filter((i) => foldOf.get(usable[i]!.session) === f);
        const trBw = bwIdx.filter((i) => foldOf.get(usable[i]!.session) !== f);
        if (te.length === 0 || trBw.length < 20) continue;
        // The colour rows are never held out: no B&W test shoot appears in them,
        // and a colour frame of a shared shoot still describes a different edit.
        const sets: Record<'own' | 'pooled', number[]> = { own: trBw, pooled: [...trBw, ...colIdx] };
        for (const which of ['own', 'pooled'] as const) {
          const tr = sets[which];
          const lambda = selectLambda(dx, dy, k, tr, keys, usable, opts.folds, s);
          const fit = fitRidge(tr.map((i) => dx[i]!), tr.map((i) => dy[i]![k]!), lambda);
          for (const i of te) {
            acc[which].model += Math.abs(fit.predict(dx[i]!) - dy[i]![k]!);
            acc[which].base += Math.abs(dy[i]![k]!);
          }
        }
      }
      for (const which of ['own', 'pooled'] as const) {
        if (acc[which].base > 0) scores[which].push(1 - acc[which].model / acc[which].base);
      }
    }
    const own = mean(scores.own);
    const pooled = mean(scores.pooled);
    console.log(
      `  ${SHARED[k]!.key.padEnd(20)} ${(own * 100).toFixed(1).padStart(7)}% ${(pooled * 100).toFixed(1).padStart(8)}% ` +
        `${`±${(sd(scores.pooled) * 100).toFixed(1)}`.padStart(10)} ${`${((pooled - own) * 100).toFixed(1)}`.padStart(8)} ` +
        `${sd(truth).toFixed(2).padStart(9)}`,
    );
  }

  console.log(
    '\n  Skill is against "no per-frame modulation" on B&W frames, shoots held out —\n' +
      '  the same baseline as within-shoot skill in BASELINE.md. "change" is what\n' +
      '  pooling the colour deviations buys; read it against ±shuffle.',
  );
}

main();
