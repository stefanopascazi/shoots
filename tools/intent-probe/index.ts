/**
 * intent-probe — how much of the photographer's departure from a standard
 * development can be read off the photograph, and from what?
 *
 *   bun tools/intent-probe/index.ts --data train_v2.jsonl --cache look-hist.json
 *
 * S_A is a standard development: the tone solver asked only for a tidy
 * histogram (shadows off the floor, median mid-grey, highlights under white).
 * The residual R = photographer − S_A, per frame, is the photographer's
 * intention measured against that ruler. The questions:
 *
 *   1. How is R made: a constant (fixed style), a per-shoot choice, or per frame?
 *   2. What explains the per-frame part: the global histogram, the content (CLIP), both?
 *   3. Does predicting S_A + R beat predicting the sliders directly — at full n and at n = 40?
 *   4. Does R come in distinct modes, or is it one blob a mean describes well?
 *
 * Shoots are held out whole; ridge λ is chosen inside each training fold.
 * `--cache` is the histogram cache written by `tools/look-probe`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { kmeans } from '../../packages/cli/src/develop/diagnose/kmeans.js';
import { solveTone } from '../../packages/cli/src/develop/look/solve.js';
import {
  LOOK_PERCENTILES,
  lookOf,
  NEUTRAL_TONE,
  TONE_KEYS,
  toneToDevelop,
  type LumaHistogram,
} from '../../packages/cli/src/develop/look/tone.js';
import { fitRidgeCV, foldsByGroup, mean, sd, shuffled, type Fitted } from '../lib/fit.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const DATA = arg('data', 'train_v2.jsonl');
const CACHE = arg('cache', 'look-hist.json');
const FOLDS = 5;
const LAMBDAS = [0.1, 1, 10, 100];
const COLD_N = 40;
const COLD_REPEATS = 10;

interface Row {
  file: string;
  session: string;
  develop: Record<string, number>;
  features: number[];
  embedding: number[];
}

if (!existsSync(CACHE)) throw new Error(`no histogram cache at ${CACHE} — run tools/look-probe first`);
const cache: Record<string, { counts: number[]; anchor: number }> = JSON.parse(readFileSync(CACHE, 'utf8'));
const rows: Row[] = readFileSync(DATA, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => r.edited && r.treatment === 'color' && r.develop && r.features && r.embedding && cache[r.file])
  .map((r) => ({ ...r, session: path.dirname(r.file) }));
const hist = (r: Row): LumaHistogram => ({ counts: Float64Array.from(cache[r.file]!.counts), anchor: cache[r.file]!.anchor });

// The ruler. Three percentiles pinned, the rest free: a tidy histogram, nothing more.
const STANDARD = LOOK_PERCENTILES.map((p) => (p === 0.01 ? 0.02 : p === 0.5 ? 0.42 : p === 0.99 ? 0.93 : 0));
const STANDARD_W = LOOK_PERCENTILES.map((p) => (p === 0.01 || p === 0.5 || p === 0.99 ? 1 : 0));
const P = TONE_KEYS.length;
const truth = (r: Row): number[] => TONE_KEYS.map((k) => r.develop[k] ?? 0);
const sA = new Map<Row, number[]>();
for (const r of rows) {
  const t = solveTone(hist(r), STANDARD, { weights: STANDARD_W });
  sA.set(r, TONE_KEYS.map((k) => toneToDevelop(t)[k]));
}
const resid = (r: Row): number[] => truth(r).map((v, i) => v - sA.get(r)![i]!);
console.log(`${rows.length} frames, ${new Set(rows.map((r) => r.session)).size} shoots\n`);

// ── 1. What R is made of ─────────────────────────────────────────────────────
const label = (k: string): string => k.replace('2012', '').slice(0, 10).padEnd(11);
const f = (v: number, w = 8, d = 1): string => v.toFixed(d).padStart(w);
console.log('1. residual R = photographer − standard (S_A)');
console.log(`${'param'.padEnd(11)}${'mean'.padStart(8)}${'sd'.padStart(8)}${'const%'.padStart(8)}${'shoot%'.padStart(8)}${'frame%'.padStart(8)}`);
const bySession = new Map<string, Row[]>();
for (const r of rows) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r]);
for (let i = 0; i < P; i++) {
  const v = rows.map((r) => resid(r)[i]!);
  const m = mean(v);
  const total = mean(v.map((x) => x * x));
  const between = mean(rows.map((r) => (mean(bySession.get(r.session)!.map((q) => resid(q)[i]!)) - m) ** 2));
  const within = total - m * m - between;
  console.log(`${label(TONE_KEYS[i]!)}${f(m, 8, i ? 1 : 2)}${f(sd(v), 8, i ? 1 : 2)}${f((100 * m * m) / total)}${f((100 * between) / total)}${f((100 * within) / total)}`);
}
console.log('const% = fixed style, shoot% = per-shoot choice, frame% = moves frame to frame (shares of R²)\n');

// ── 2–3. What explains R, and does the ruler help ────────────────────────────
const SETS: Record<string, (r: Row) => number[]> = {
  histogram: (r) => [...lookOf(hist(r), NEUTRAL_TONE), hist(r).anchor, ...r.features],
  content: (r) => r.embedding,
  both: (r) => [...lookOf(hist(r), NEUTRAL_TONE), hist(r).anchor, ...r.features, ...r.embedding],
};

const fitCV = (train: Row[], X: number[][], y: number[]): Fitted =>
  fitRidgeCV(X, y, train.map((r) => r.session), LAMBDAS);

type Method = { name: string; predict: (train: Row[], test: Row[]) => number[][] };
const constOf = (train: Row[], get: (r: Row) => number[]): number[] =>
  Array.from({ length: P }, (_, i) => mean(train.map((r) => get(r)[i]!)));

const METHODS: Method[] = [
  { name: 'preset (mean sliders)', predict: (tr, te) => te.map(() => constOf(tr, truth)) },
  { name: 'S_A alone', predict: (_tr, te) => te.map((r) => sA.get(r)!) },
  { name: 'S_A + mean R', predict: (tr, te) => te.map((r) => sA.get(r)!.map((v, i) => v + constOf(tr, resid)[i]!)) },
];
for (const [set, feats] of Object.entries(SETS)) {
  METHODS.push({
    name: `direct, ${set}`,
    predict: (tr, te) => {
      const X = tr.map(feats);
      const fits = Array.from({ length: P }, (_, i) => fitCV(tr, X, tr.map((r) => truth(r)[i]!)));
      return te.map((r) => fits.map((m) => m.predict(feats(r))));
    },
  });
  // S_A also goes in as an input: the fit learns how far to follow the ruler, per slider.
  METHODS.push({
    name: `S_A + R, ${set}`,
    predict: (tr, te) => {
      const fx = (r: Row): number[] => [...feats(r), ...sA.get(r)!];
      const X = tr.map(fx);
      const fits = Array.from({ length: P }, (_, i) => fitCV(tr, X, tr.map((r) => resid(r)[i]!)));
      return te.map((r) => fits.map((m, i) => sA.get(r)![i]! + m.predict(fx(r))));
    },
  });
}

function evaluate(m: Method, subsample: number | null, seed: number): number[] {
  const folds = foldsByGroup(rows.map((r) => r.session), FOLDS, 7);
  const err = Array.from({ length: P }, () => [] as number[]);
  for (let k = 0; k < FOLDS; k++) {
    let train = rows.filter((r) => folds.get(r.session) !== k);
    const test = rows.filter((r) => folds.get(r.session) === k);
    if (subsample) train = shuffled(train, seed + k).slice(0, subsample);
    const pred = m.predict(train, test);
    test.forEach((r, j) => truth(r).forEach((v, i) => err[i]!.push(Math.abs(pred[j]![i]! - v))));
  }
  return err.map(mean);
}

const header = `${'method'.padEnd(24)}${TONE_KEYS.map((k) => k.replace('2012', '').slice(0, 7).padStart(9)).join('')}`;
for (const [title, n] of [
  ['2–3. held-out MAE vs the photographer, all training frames', null],
  [`cold start: ${COLD_N} training frames, mean of ${COLD_REPEATS} draws`, COLD_N],
] as const) {
  console.log(`${title} (Camera Raw units, Exposure in EV)`);
  console.log(header);
  for (const m of METHODS) {
    const runs = n ? Array.from({ length: COLD_REPEATS }, (_, s) => evaluate(m, n, 100 + s * 13)) : [evaluate(m, null, 0)];
    const mae = Array.from({ length: P }, (_, i) => mean(runs.map((r) => r[i]!)));
    console.log(`${m.name.padEnd(24)}${mae.map((v, i) => f(v, 9, i ? 1 : 2)).join('')}`);
  }
  console.log('');
}

// ── 4. Modes ────────────────────────────────────────────────────────────────
const Z = (() => {
  const R = rows.map(resid);
  const mu = Array.from({ length: P }, (_, i) => mean(R.map((r) => r[i]!)));
  const s = Array.from({ length: P }, (_, i) => sd(R.map((r) => r[i]!)) || 1);
  return R.map((r) => r.map((v, i) => (v - mu[i]!) / s[i]!));
})();
const totalSS = Z.reduce((a, r) => a + r.reduce((b, v) => b + v * v, 0), 0);
console.log('4. modes in R: variance explained by k clusters, real vs columns shuffled independently');
for (const k of [2, 3, 4]) {
  const real = 1 - kmeans(Z, k).inertia / totalSS;
  const nulls = Array.from({ length: 5 }, (_, s) => {
    const cols = Array.from({ length: P }, (_, i) => shuffled(Z.map((r) => r[i]!), 50 + s * 7 + i));
    const Zn = Z.map((_, j) => cols.map((c) => c[j]!));
    return 1 - kmeans(Zn, k).inertia / totalSS;
  });
  console.log(`k=${k}: real ${(real * 100).toFixed(1)}%  null ${(mean(nulls) * 100).toFixed(1)}%`);
}
