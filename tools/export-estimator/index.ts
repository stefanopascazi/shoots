/**
 * export-estimator — freeze the Phase 2.5 exposure estimator into a file.
 *
 *   bun tools/export-estimator/index.ts --dataset test/datapairs --catalog train_v2.jsonl \
 *     --out tools/export-estimator/evEstimator.json
 *
 * Phase 2.5 of ENCODER-PLAN.md measured that a linear ridge from the 50
 * photometric features to the synthetic EV label predicts what the photographer
 * did to `Exposure2012` *within a shoot* — +0.0553 ± 0.0035 skill, with 22 of 24
 * shoots agreeing on the sign. This writes that ridge out.
 *
 * **The column it was written for does not ship.** Wired into the frame head it
 * bought +0.3 points of in-shoot skill against a ±5.2 fold spread, and *replacing*
 * the four tone columns with it cost 5.8 — see Phase 2.7 in ENCODER-PLAN.md. The
 * tool stays because the artifact is the record of that measurement and because
 * any future encoder is scored against this ridge, not against nothing.
 *
 * ## Why the coefficients are frozen rather than refitted per catalog
 *
 * The value of the column is that its coefficients come from 25k synthetic
 * samples instead of the few hundred edited frames in a catalog. A photographer
 * with 553 edits cannot afford to fit 50 columns for their exposure decision —
 * that is exactly what `featureSets.ts` narrows away from. Fitted once here and
 * frozen, the same 50 columns arrive as a single number the catalog ridge can
 * afford.
 *
 * ## Why the catalog's own scenes are withheld
 *
 * Pass `--catalog` and every scene that also appears in the edited catalog is
 * dropped from the fit. The estimator would otherwise have seen degraded
 * variants of the very photographs the develop trainer holds out, and the gate
 * — "does Exposure2012 in-shoot skill beat 9.3%" — would have been measured
 * against an estimator no new user could have. It costs 48 shoots.
 *
 * The whole artifact is ~150 numbers, and `featureNames` is pinned so a
 * reordering of the colour block is detectable rather than silently reading the
 * wrong columns.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { COLOR_FEATURE_NAMES, readCache } from '../label-recovery/features.js';
import { fitRidge, foldsByGroup } from '../lib/fit.js';

/** λ for the shipped fit. Phase 2 selected the bottom of the grid on 25k rows against 50 columns. */
const LAMBDA = 0.3;

interface Options {
  dataset: string;
  catalog: string | null;
  out: string;
  maxClip: number;
  folds: number;
  shuffles: number;
}

function parseArgs(argv: string[]): Options {
  const get = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataset = get('dataset');
  const out = get('out');
  if (!dataset || !out) {
    throw new Error(
      'usage: bun tools/export-estimator/index.ts --dataset <pairs-dir> --out <file.json> ' +
        '[--catalog <train.jsonl>] [--max-clip 0.05] [--folds 5] [--shuffles 20]',
    );
  }
  const catalog = get('catalog');
  return {
    dataset: path.resolve(dataset),
    catalog: catalog ? path.resolve(catalog) : null,
    out: path.resolve(out),
    maxClip: Number(get('max-clip') ?? 0.05),
    folds: Number(get('folds') ?? 5),
    shuffles: Number(get('shuffles') ?? 20),
  };
}

const norm = (p: string): string[] => p.replace(/\\/g, '/').toLowerCase().split('/');
const tail3 = (p: string): string => norm(p).slice(-3).join('/');
const sceneOf = (p: string): string => norm(p).slice(0, -1).join('/');

interface Pair {
  id: string;
  source: string;
  variant: number;
  clip: number;
  ev: number;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const pairs = readFileSync(path.join(opts.dataset, 'pairs.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as Pair);
  const cache = await readCache(path.join(opts.dataset, 'features.jsonl'));

  // Scenes to withhold: every source the edited catalog also contains.
  const withheld = new Set<string>();
  if (opts.catalog) {
    const zeroBySource = new Map(pairs.filter((r) => r.variant === 0).map((r) => [tail3(r.source), r]));
    for (const line of readFileSync(opts.catalog, 'utf8').trim().split('\n')) {
      const r = JSON.parse(line) as { file?: string; edited?: boolean };
      if (r.edited === false || !r.file) continue;
      const z = zeroBySource.get(tail3(r.file));
      if (z) withheld.add(sceneOf(z.source));
    }
  }

  const train = pairs.filter(
    (r) => r.variant !== 0 && r.clip <= opts.maxClip && !withheld.has(sceneOf(r.source)) && cache.has(r.id),
  );
  if (train.length < 1000) throw new Error(`too few usable samples: ${train.length}`);

  const X = train.map((r) => cache.get(r.id)!);
  const y = train.map((r) => r.ev);
  const width = X[0]!.length;
  if (width !== COLOR_FEATURE_NAMES.length) {
    throw new Error(`feature width ${width} does not match COLOR_FEATURE_NAMES (${COLOR_FEATURE_NAMES.length})`);
  }

  const fit = fitRidge(X, y, LAMBDA);

  // Held-out skill, whole *shoots* withheld — the provenance number that travels
  // with the artifact. Not the gate (that is the develop run), but the figure
  // that says whether this file is the one Phase 2 measured. Grouping by folder
  // rather than by photograph is stricter than Phase 2's own 0.369, which held
  // out single sources; the five variants of one frame cannot straddle a fold
  // either way.
  const scenes = train.map((r) => sceneOf(r.source));
  const skills: number[] = [];
  for (let s = 0; s < opts.shuffles; s++) {
    const foldOf = foldsByGroup(scenes, opts.folds, s + 1);
    let model = 0;
    let base = 0;
    for (let f = 0; f < opts.folds; f++) {
      const tr: number[] = [];
      const te: number[] = [];
      scenes.forEach((sc, i) => (foldOf.get(sc) === f ? te : tr).push(i));
      if (tr.length < 100 || te.length === 0) continue;
      const inner = fitRidge(tr.map((i) => X[i]!), tr.map((i) => y[i]!), LAMBDA);
      for (const i of te) {
        model += Math.abs(inner.predict(X[i]!) - y[i]!);
        base += Math.abs(inner.ybar - y[i]!);
      }
    }
    skills.push(base > 0 ? 1 - model / base : 0);
  }
  const skill = skills.reduce((a, b) => a + b, 0) / skills.length;
  const skillSd = Math.sqrt(skills.reduce((a, v) => a + (v - skill) ** 2, 0) / skills.length);

  const round = (v: number): number => Math.round(v * 1e9) / 1e9;
  const artifact = {
    kind: 'ev-estimator',
    version: 1,
    featureNames: [...COLOR_FEATURE_NAMES],
    mean: fit.stats.mean.map(round),
    std: fit.stats.std.map(round),
    coef: fit.coef.map(round),
    bias: round(fit.bias),
    yspread: round(fit.yspread),
    ybar: round(fit.ybar),
    provenance: {
      dataset: path.basename(opts.dataset),
      samples: train.length,
      photographs: new Set(train.map((r) => r.source)).size,
      shoots: new Set(scenes).size,
      withheldShoots: withheld.size,
      maxClip: opts.maxClip,
      lambda: LAMBDA,
      heldOutSkill: round(skill),
      heldOutSkillSd: round(skillSd),
      builtAt: new Date().toISOString().slice(0, 10),
    },
  };

  mkdirSync(path.dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  console.log(
    `samples ${train.length} · photographs ${artifact.provenance.photographs} · ` +
      `shoots ${artifact.provenance.shoots} · withheld ${withheld.size} shoots`,
  );
  console.log(`held-out ev skill ${skill.toFixed(4)} ±${skillSd.toFixed(4)} (Phase 2 read 0.369 with per-fold λ)`);
  console.log(`wrote ${opts.out}`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
