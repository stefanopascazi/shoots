/**
 * shoot-calibration — after the photographer edits k frames of a new shoot, how
 * much better are the predictions for the rest of it?
 *
 *   bun tools/shoot-calibration/index.ts --data train_v2.jsonl --cache look-hist.json
 *
 * The probes before this one agree: per-frame information buys ~10-15% at most,
 * and the largest unexplained share of the photographer's choices is per shoot —
 * the intention for that job, decided before the shutter. No pixel carries it;
 * the first frames the photographer edits do.
 *
 * For every held-out shoot, k of its edited frames are revealed (random order,
 * several draws) and the remaining frames are predicted by:
 *
 *   preset         training mean of each slider (no model, no calibration)
 *   global         ridge from the histogram, trained on other shoots
 *   shoot mean     the mean of the k revealed frames (an in-shoot preset)
 *   global+offset  global, shifted by the mean error it made on the k revealed frames
 *   global+shrunk  the same offset, shrunk by k/(k+κ) with κ = within/between
 *                  variance measured on the training shoots (empirical Bayes)
 *
 * All methods are scored on the same remaining frames, so the columns compare.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { lookOf, NEUTRAL_TONE, TONE_KEYS, type LumaHistogram } from '../../packages/cli/src/develop/look/tone.js';
import { fitRidgeCV, foldsByGroup, mean, shuffled, type Fitted } from '../lib/fit.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const DATA = arg('data', 'train_v2.jsonl');
const CACHE = arg('cache', 'look-hist.json');
const FOLDS = 5;
const KS = [0, 1, 3, 5, 10];
const DRAWS = 10;

interface Row {
  file: string;
  session: string;
  develop: Record<string, number>;
  features: number[];
}

if (!existsSync(CACHE)) throw new Error(`no histogram cache at ${CACHE} — run tools/look-probe first`);
const cache: Record<string, { counts: number[]; anchor: number }> = JSON.parse(readFileSync(CACHE, 'utf8'));
const rows: Row[] = readFileSync(DATA, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => r.edited && r.treatment === 'color' && r.develop && r.features && cache[r.file])
  .map((r) => ({ ...r, session: path.dirname(r.file) }));

const featCache = new Map<Row, number[]>();
const feats = (r: Row): number[] => {
  let x = featCache.get(r);
  if (!x) {
    const h: LumaHistogram = { counts: Float64Array.from(cache[r.file]!.counts), anchor: cache[r.file]!.anchor };
    featCache.set(r, (x = [...lookOf(h, NEUTRAL_TONE), h.anchor, ...r.features]));
  }
  return x;
};
const P = TONE_KEYS.length;
const truth = (r: Row): number[] => TONE_KEYS.map((k) => r.develop[k] ?? 0);

/** κ per slider: how many in-shoot frames it takes before the shoot outweighs the global model. */
function kappa(train: Row[], residual: (r: Row, i: number) => number, i: number): number {
  const by = new Map<string, number[]>();
  for (const r of train) by.set(r.session, [...(by.get(r.session) ?? []), residual(r, i)]);
  const groups = [...by.values()].filter((g) => g.length > 1);
  const within = mean(groups.flatMap((g) => g.map((v) => (v - mean(g)) ** 2)));
  const grand = mean(groups.flat());
  const between = Math.max(1e-9, mean(groups.map((g) => (mean(g) - grand) ** 2)) - within / mean(groups.map((g) => g.length)));
  return within / between;
}

const METHODS = ['preset', 'global', 'shoot mean', 'global+offset', 'global+shrunk'] as const;
type Method = (typeof METHODS)[number];
// err[k][method][param] → absolute errors
const err = new Map<number, Record<Method, number[][]>>(
  KS.map((k) => [k, Object.fromEntries(METHODS.map((m) => [m, Array.from({ length: P }, () => [] as number[])])) as Record<Method, number[][]>]),
);
const kappas: number[][] = [];

const folds = foldsByGroup(rows.map((r) => r.session), FOLDS, 7);
for (let f = 0; f < FOLDS; f++) {
  const train = rows.filter((r) => folds.get(r.session) !== f);
  const test = rows.filter((r) => folds.get(r.session) === f);
  const X = train.map(feats);
  const groups = train.map((r) => r.session);
  const models: Fitted[] = Array.from({ length: P }, (_, i) => fitRidgeCV(X, train.map((r) => truth(r)[i]!), groups));
  const preset = Array.from({ length: P }, (_, i) => mean(train.map((r) => truth(r)[i]!)));
  // κ from the global model's own in-sample residuals on the training shoots.
  const kap = Array.from({ length: P }, (_, i) => kappa(train, (r, j) => truth(r)[j]! - models[j]!.predict(feats(r)), i));
  kappas.push(kap);

  const shoots = new Map<string, Row[]>();
  for (const r of test) shoots.set(r.session, [...(shoots.get(r.session) ?? []), r]);
  for (const frames of shoots.values()) {
    for (const k of KS) {
      // Two frames must remain to be predicted, or the shoot says nothing at this k.
      if (frames.length < k + 2) continue;
      for (let d = 0; d < (k ? DRAWS : 1); d++) {
        const order = shuffled(frames, 1000 * f + 31 * d + k);
        const seen = order.slice(0, k);
        const rest = order.slice(k);
        for (let i = 0; i < P; i++) {
          const g = (r: Row): number => models[i]!.predict(feats(r));
          const offset = k ? mean(seen.map((r) => truth(r)[i]! - g(r))) : 0;
          const shootMean = k ? mean(seen.map((r) => truth(r)[i]!)) : preset[i]!;
          const shrink = k / (k + kap[i]!);
          for (const r of rest) {
            const y = truth(r)[i]!;
            const e = err.get(k)!;
            e.preset[i]!.push(Math.abs(preset[i]! - y));
            e.global[i]!.push(Math.abs(g(r) - y));
            e['shoot mean'][i]!.push(Math.abs(shootMean - y));
            e['global+offset'][i]!.push(Math.abs(g(r) + offset - y));
            e['global+shrunk'][i]!.push(Math.abs(g(r) + shrink * offset - y));
          }
        }
      }
    }
  }
}

const fmt = (v: number, i: number): string => v.toFixed(i ? 1 : 2).padStart(9);
console.log(`${rows.length} frames, ${new Set(rows.map((r) => r.session)).size} shoots`);
console.log(`κ (frames before the shoot outweighs the model): ${TONE_KEYS.map((k, i) => `${k.replace('2012', '')} ${mean(kappas.map((x) => x[i]!)).toFixed(1)}`).join(', ')}\n`);
for (const k of KS) {
  const e = err.get(k)!;
  console.log(`k = ${k} frames edited in the shoot (MAE on the rest, ${e.preset[0]!.length} predictions)`);
  console.log(`${'method'.padEnd(15)}${TONE_KEYS.map((t) => t.replace('2012', '').slice(0, 7).padStart(9)).join('')}`);
  for (const m of METHODS) {
    if (k === 0 && m !== 'preset' && m !== 'global') continue;
    console.log(`${m.padEnd(15)}${e[m].map((v, i) => fmt(mean(v), i)).join('')}`);
  }
  console.log('');
}
