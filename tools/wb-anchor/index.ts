/**
 * wb-anchor — which reference should the Temperature delta be stated against?
 *
 *   bun tools/wb-anchor/index.ts --data train_v2.jsonl
 *
 * `Temperature` gates out on the reference catalog (ENCODER-PLAN.md Phase 0:
 * −2.1% for the ridge), which means what actually ships for it is the *anchor* —
 * the reference Kelvin multiplied by one learned offset:
 *
 *     predicted = ref × exp(mean log(chosen / ref) over the training folds)
 *
 * So the only lever on white balance is the choice of `ref`, and this measures
 * it. Three candidates, all held out by whole shoot:
 *
 *   A  a global constant Kelvin      — the baseline a skill score is against
 *   B  `tempAsShot`, the WB dial     — what ships today
 *   C  `tempMeasured`, what the body metered from the light
 *
 * ## Why the unit is Kelvin and not skill
 *
 * The delta space *is* the thing being changed: with `ref = tempAsShot` the
 * target is log(chosen/asShot), with `tempMeasured` it is log(chosen/measured).
 * Two skill scores computed against two different targets are not comparable,
 * and reading them side by side is how a change like this gets adopted on a
 * number that means nothing. Absolute error on the photographer's chosen Kelvin
 * is the same question for every scheme.
 *
 * ## Coverage is reported, and it matters
 *
 * `tempMeasured` comes from EXIF `ColorTempMeasured` and not every body writes
 * it. Scheme C falls back to `tempAsShot` per frame, exactly as the shipped
 * `refValue` would, so the figure it reports is what a catalog with *this*
 * coverage would see — not what a fully-covered one would.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { foldsByGroup, mean, sd } from '../lib/fit.js';

interface Options {
  data: string;
  folds: number;
  shuffles: number;
}

function parseArgs(argv: string[]): Options {
  const get = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const data = get('data');
  if (!data) throw new Error('usage: bun tools/wb-anchor/index.ts --data <train.jsonl> [--folds 5] [--shuffles 20]');
  return { data: path.resolve(data), folds: Number(get('folds') ?? 5), shuffles: Number(get('shuffles') ?? 20) };
}

/** The shoot a frame belongs to: its containing folder, as the trainer groups. */
const sessionOf = (file: string): string => file.split(/[\\/]/).slice(0, -1).join('/').toLowerCase();

interface Frame {
  session: string;
  chosen: number;
  asShot: number;
  /** Null where the body reported nothing — scheme C falls back per frame. */
  measured: number | null;
}

/** One anchoring scheme: what reference Kelvin this frame is stated against. */
interface Scheme {
  name: string;
  ref: (f: Frame) => number;
}

const median = (v: readonly number[]): number => {
  const a = [...v].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
};

interface SchemeResult {
  mae: number;
  spread: number;
  /** Held-out absolute error per frame, averaged over the shuffles. */
  perFrame: number[];
}

/**
 * Held-out MAE in Kelvin for one scheme.
 *
 * The fit is a single scalar — the mean log ratio between the chosen Kelvin and
 * the reference — which is exactly what a gated parameter emits. Whole shoots
 * are held out, so a shoot's own offset can never be learned from its neighbours.
 *
 * `perFrame` carries the same errors back out unaggregated, so two schemes can be
 * compared shoot by shoot afterwards. Comparing raw `|ref − chosen|` instead would
 * answer a different question and answer it wrongly: each scheme applies its own
 * learned offset, so a reference that is systematically low is not thereby worse.
 */
function heldOutMae(frames: Frame[], scheme: Scheme, folds: number, shuffles: number): SchemeResult {
  const keys = frames.map((f) => f.session);
  const per: number[] = [];
  const acc = new Array<number>(frames.length).fill(0);
  const hits = new Array<number>(frames.length).fill(0);
  for (let s = 0; s < shuffles; s++) {
    const foldOf = foldsByGroup(keys, folds, s + 1);
    let err = 0;
    let n = 0;
    for (let f = 0; f < folds; f++) {
      const tr: number[] = [];
      const te: number[] = [];
      frames.forEach((x, i) => (foldOf.get(x.session) === f ? te : tr).push(i));
      if (tr.length < 10 || te.length === 0) continue;
      const offset = mean(tr.map((i) => Math.log(frames[i]!.chosen) - Math.log(scheme.ref(frames[i]!))));
      for (const i of te) {
        const x = frames[i]!;
        const e = Math.abs(scheme.ref(x) * Math.exp(offset) - x.chosen);
        err += e;
        n++;
        acc[i]! += e;
        hits[i]!++;
      }
    }
    if (n > 0) per.push(err / n);
  }
  return { mae: mean(per), spread: sd(per), perFrame: acc.map((v, i) => (hits[i]! > 0 ? v / hits[i]! : Number.NaN)) };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  const frames: Frame[] = [];
  let edited = 0;
  for (const line of readFileSync(opts.data, 'utf8').trim().split('\n')) {
    const r = JSON.parse(line) as {
      file?: string;
      edited?: boolean;
      develop?: Record<string, number>;
      asShot?: { tempAsShot?: number | null; tempMeasured?: number | null };
    };
    if (r.edited === false || !r.file) continue;
    edited++;
    const chosen = r.develop?.Temperature;
    const asShot = r.asShot?.tempAsShot;
    // A frame with no explicit Temperature sits on its as-shot value by
    // definition, so including it would score every scheme on a row where the
    // photographer made no white-balance decision at all.
    if (!chosen || !Number.isFinite(chosen) || !asShot || !Number.isFinite(asShot)) continue;
    const m = r.asShot?.tempMeasured;
    frames.push({
      session: sessionOf(r.file),
      chosen,
      asShot,
      measured: m && Number.isFinite(m) ? m : null,
    });
  }

  const shoots = new Set(frames.map((f) => f.session)).size;
  const covered = frames.filter((f) => f.measured !== null).length;
  console.log(`${edited} edited · ${frames.length} with a chosen Temperature · ${shoots} shoots`);
  console.log(`tempMeasured present on ${covered}/${frames.length} (${((100 * covered) / frames.length).toFixed(1)}%)\n`);
  if (frames.length < 50) throw new Error('too few frames with an explicit Temperature');

  const globalMean = Math.exp(mean(frames.map((f) => Math.log(f.chosen))));
  const schemes: Scheme[] = [
    { name: 'A  global constant Kelvin', ref: () => globalMean },
    { name: 'B  tempAsShot (ships today)', ref: (f) => f.asShot },
    { name: 'C  tempMeasured, else asShot', ref: (f) => f.measured ?? f.asShot },
  ];

  const results = schemes.map((s) => ({ name: s.name, ...heldOutMae(frames, s, opts.folds, opts.shuffles) }));
  const base = results[0]!.mae;
  console.log('  scheme                        held-out MAE      ±shuffle   skill vs A');
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(28)} ${`${r.mae.toFixed(0)} K`.padStart(12)}   ${`±${r.spread.toFixed(1)}`.padStart(9)}   ${(1 - r.mae / base).toFixed(3).padStart(10)}`,
    );
  }

  const b = results[1]!.mae;
  const c = results[2]!.mae;
  console.log(`\n  C against B: ${(b - c).toFixed(0)} K, skill ${(1 - c / b).toFixed(4)}`);

  // Agreement across shoots — the column Phase 2.5 taught us to trust over a
  // pooled figure, because two high-variance shoots can manufacture one. Both
  // schemes are compared on their *held-out* error, each with its own learned
  // offset already applied.
  const errB = results[1]!.perFrame;
  const errC = results[2]!.perFrame;
  let better = 0;
  let total = 0;
  const margins: number[] = [];
  for (const shoot of new Set(frames.map((f) => f.session))) {
    const idx = frames.map((_, i) => i).filter((i) => frames[i]!.session === shoot && Number.isFinite(errB[i]!));
    if (idx.length < 4) continue;
    total++;
    const b = mean(idx.map((i) => errB[i]!));
    const c = mean(idx.map((i) => errC[i]!));
    margins.push(b - c);
    if (c < b) better++;
  }
  console.log(`  shoots the measured reference improves: ${better}/${total}`);
  console.log(
    `  per-shoot margin (B − C): median ${median(margins).toFixed(0)} K, ` +
      `worst ${Math.min(...margins).toFixed(0)} K, best ${Math.max(...margins).toFixed(0)} K`,
  );

  reportSteadiness(frames);
}

/**
 * The mechanism behind the pooled figure, and the reason it is misleading.
 *
 * A reference is only as good as the *steadiness* of the offset it needs: the
 * model gets one scalar per shoot, so what matters is how much log(chosen / ref)
 * varies inside a shoot, not how close `ref` sits to `chosen` on average.
 *
 * Measured that way `tempAsShot` is not merely competitive — in several shoots it
 * is **exact**, spread zero, because the photographer's chosen Kelvin is a fixed
 * ratio of the dial they set. `tempMeasured` re-meters frame by frame, so
 * substituting it injects variation into precisely the shoots where there was
 * none to explain.
 */
function reportSteadiness(frames: Frame[]): void {
  const rows: Array<{ shoot: string; n: number; gap: number; sdB: number; sdC: number }> = [];
  for (const shoot of new Set(frames.map((f) => f.session))) {
    const sub = frames.filter((f) => f.session === shoot);
    if (sub.length < 4) continue;
    const spread = (v: number[]): number => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
    rows.push({
      shoot,
      n: sub.length,
      gap: mean(sub.map((f) => Math.abs(Math.log((f.measured ?? f.asShot) / f.asShot)))),
      sdB: spread(sub.map((f) => Math.log(f.chosen / f.asShot))),
      sdC: spread(sub.map((f) => Math.log(f.chosen / (f.measured ?? f.asShot)))),
    });
  }
  const exactB = rows.filter((r) => r.sdB < 1e-9).length;
  const exactC = rows.filter((r) => r.sdC < 1e-9).length;
  const steadier = rows.filter((r) => r.sdC < r.sdB).length;
  const biggest = [...rows].sort((a, b) => b.gap - a.gap)[0]!;

  console.log('');
  console.log('  How steady an offset each reference needs, inside a shoot (lower is better):');
  console.log(`    mean sd of log(chosen/ref) — B ${mean(rows.map((r) => r.sdB)).toFixed(4)}   C ${mean(rows.map((r) => r.sdC)).toFixed(4)}`);
  console.log(`    shoots where the reference is EXACT (one ratio explains the whole shoot) — B ${exactB}/${rows.length}   C ${exactC}/${rows.length}`);
  console.log(`    shoots where C needs a steadier offset than B: ${steadier}/${rows.length}`);
  console.log(
    `    the shoot the two references disagree on most: ${biggest.shoot.split('/').slice(-1)[0]} ` +
      `(n=${biggest.n}, |log meas/asShot| ${biggest.gap.toFixed(3)}, sd B ${biggest.sdB.toFixed(3)} vs C ${biggest.sdC.toFixed(3)})`,
  );
}

main();
