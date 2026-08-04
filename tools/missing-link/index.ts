/**
 * missing-link — does a "how far from neutral" estimate predict the edit?
 *
 *   bun tools/missing-link/index.ts --dataset test/datapairs --catalog train_v2.jsonl
 *
 * Phase 2 measured that the photometric features recover a third of a *synthetic*
 * degradation. That is the first of three links, and only the first:
 *
 *   1. an encoder recovers the synthetic degradation          — measured, 0.36
 *   2. so it estimates how wrong the camera's as-shot was     — plausible
 *   3. so that estimate predicts what the photographer chose  — THIS TOOL
 *
 * Link 3 is what the whole encoder bet rests on, and it is not obvious. A
 * photographer moves a slider for two unrelated reasons: because the capture was
 * wrong, or because they like it that way. An encoder can only ever see the
 * first. If the corrections in a catalog are mostly taste, a perfect encoder
 * moves nothing.
 *
 * ## Why the question is asked *within* a shoot
 *
 * Asked globally, this test answers the wrong thing and answers it confusingly:
 * the pooled correlation for white balance is 0.50 while the pooled held-out
 * skill is 0.00. The reason is the same one the shipped model is split in two
 * heads for — a slider has a per-shoot level and a per-frame deviation, and they
 * are different questions. A global linear map fitted across shoots spends itself
 * on session offsets and predicts nothing inside any of them.
 *
 * So the measurement here is the frame head's question, and its baseline is what
 * the model does today with that head gated: give every frame in a shoot the
 * shoot's own level. Skill above zero means the estimate earns per-frame
 * modulation.
 *
 * ## Reading the output
 *
 * `sess with sign` is the load-bearing column. A pooled correlation can be
 * manufactured by two or three high-variance shoots; a relationship that holds in
 * 22 of 24 shoots cannot. Where `sd dev` is 0 the photographer never varied that
 * slider inside a shoot at all, and no estimator can predict variance that does
 * not exist.
 *
 * A negative result is suggestive, not conclusive — a weak estimator failing does
 * not prove a strong one would. A positive one is strong evidence, because it
 * shows the photographer demonstrably acts on what an encoder would see.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readCache } from '../label-recovery/features.js';
import { correlation, fitRidge, foldsByGroup, mean, sd } from '../lib/fit.js';

/** Catalog parameters worth asking about: the ones a photometric read could touch. */
const PARAMS = [
  'Exposure2012', 'Highlights2012', 'Shadows2012', 'Whites2012',
  'Blacks2012', 'Contrast2012', 'Clarity2012', 'Vibrance',
] as const;

const WB = 'WB (mired)';
const MIN_FRAMES = 4;

interface Options {
  dataset: string;
  catalog: string;
  folds: number;
  shuffles: number;
  maxClip: number;
}

function parseArgs(argv: string[]): Options {
  const get = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataset = get('dataset');
  const catalog = get('catalog');
  if (!dataset || !catalog) {
    throw new Error(
      'usage: bun tools/missing-link/index.ts --dataset <pairs-dir> --catalog <train.jsonl> ' +
        '[--folds 5] [--shuffles 20] [--max-clip 0.05]',
    );
  }
  return {
    dataset: path.resolve(dataset),
    catalog: path.resolve(catalog),
    folds: Number(get('folds') ?? 5),
    shuffles: Number(get('shuffles') ?? 20),
    maxClip: Number(get('max-clip') ?? 0.05),
  };
}

const norm = (p: string): string[] => p.replace(/\\/g, '/').toLowerCase().split('/');
const tail3 = (p: string): string => norm(p).slice(-3).join('/');
const sceneOf = (p: string): string => norm(p).slice(0, -1).join('/');

/** Kelvin → mired. A white-balance *shift* is uniform in mired, not in Kelvin. */
const mired = (k: number): number => 1e6 / Math.max(1, k);

interface Frame {
  scene: string;
  x: number[];
  value: Record<string, number>;
}

/** Per-group means, used to split a target into its level and its deviation. */
function groupMeans(keys: readonly string[], values: readonly number[]): Map<string, number> {
  const acc = new Map<string, [number, number]>();
  keys.forEach((k, i) => {
    const a = acc.get(k) ?? [0, 0];
    a[0] += values[i]!;
    a[1]++;
    acc.set(k, a);
  });
  return new Map([...acc].map(([k, [s, n]]) => [k, s / n]));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const pairs = readFileSync(path.join(opts.dataset, 'pairs.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { id: string; source: string; variant: number; clip: number; mired: number; ev: number });
  const cache = await readCache(path.join(opts.dataset, 'features.jsonl'));
  const catalog = readFileSync(opts.catalog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r: any) => r.edited !== false && r.asShot?.tempAsShot);

  // Every edited frame is also in the pairs dataset, so its *variant 0* — the
  // undegraded render — has features from the identical pipeline. That is what
  // makes the transfer meaningful rather than a comparison across two renderers.
  const zeroBySource = new Map(pairs.filter((r) => r.variant === 0).map((r) => [tail3(r.source), r]));
  const catalogScenes = new Set<string>();
  const frames: Frame[] = [];
  for (const r of catalog as any[]) {
    const z = zeroBySource.get(tail3(r.file));
    if (!z) continue;
    catalogScenes.add(sceneOf(z.source));
    const x = cache.get(z.id);
    if (!x) continue;
    const value: Record<string, number> = {};
    for (const p of PARAMS) value[p] = r.develop?.[p] ?? 0;
    // Positive when the photographer warmed the frame, matching the sign of the
    // synthetic label (positive = the render looks cooler than it should).
    value[WB] = r.develop?.Temperature ? mired(r.asShot.tempAsShot) - mired(r.develop.Temperature) : NaN;
    frames.push({ scene: sceneOf(r.file), x, value });
  }
  console.log(`catalog ${catalog.length} edited · matched ${frames.length} · ${new Set(frames.map((f) => f.scene)).size} shoots`);
  if (frames.length < 50) throw new Error('too few matched frames');

  // ── the estimators, catalog scenes withheld ────────────────────────────────
  const train = pairs.filter(
    (r) => r.variant !== 0 && r.clip <= opts.maxClip && !catalogScenes.has(sceneOf(r.source)) && cache.has(r.id),
  );
  console.log(`synthetic training set ${train.length} samples, ${catalogScenes.size} catalog scenes withheld\n`);
  const X = train.map((r) => cache.get(r.id)!);
  const evEst = fitRidge(X, train.map((r) => r.ev), 0.3);
  const wbEst = fitRidge(X, train.map((r) => r.mired), 0.03);

  console.log('  parameter          n  shoots   r within   sess w/ sign        skill within   sd dev');
  for (const p of [...PARAMS, WB]) {
    const usable = frames.filter((f) => Number.isFinite(f.value[p]));
    const shoots = [...new Set(usable.map((f) => f.scene))].filter(
      (s) => usable.filter((f) => f.scene === s).length >= MIN_FRAMES,
    );
    const g = usable.filter((f) => shoots.includes(f.scene));
    if (g.length < 50) continue;

    const keys = g.map((f) => f.scene);
    // The white-balance estimator answers the white-balance question; everything
    // tonal is asked of the exposure estimator, which is the general "how far
    // from a correct rendering is this" reading.
    const est = g.map((f) => (p === WB ? wbEst.predict(f.x) : evEst.predict(f.x)));
    const truth = g.map((f) => f.value[p]!);
    const me = groupMeans(keys, est);
    const my = groupMeans(keys, truth);
    const de = g.map((f, i) => est[i]! - me.get(f.scene)!);
    const dy = g.map((f, i) => truth[i]! - my.get(f.scene)!);

    if (sd(dy) < 1e-9) {
      console.log(`  ${p.padEnd(16)} ${String(g.length).padStart(4)} ${String(shoots.length).padStart(6)}   never varied within a shoot`);
      continue;
    }

    // How many shoots agree on the sign — the column that separates a real
    // relationship from one manufactured by two high-variance shoots.
    let agree = 0;
    const pooled = correlation(de, dy);
    for (const s of shoots) {
      const idx = g.map((_, i) => i).filter((i) => g[i]!.scene === s);
      const a = idx.map((i) => de[i]!);
      const b = idx.map((i) => dy[i]!);
      if (sd(a) > 0 && sd(b) > 0 && Math.sign(correlation(a, b)) === Math.sign(pooled)) agree++;
    }

    const per: number[] = [];
    for (let s = 0; s < opts.shuffles; s++) {
      const foldOf = foldsByGroup(keys, opts.folds, s + 1);
      let model = 0;
      let base = 0;
      for (let f = 0; f < opts.folds; f++) {
        const tr: number[] = [];
        const te: number[] = [];
        g.forEach((v, i) => (foldOf.get(v.scene) === f ? te : tr).push(i));
        if (tr.length < 20 || te.length === 0) continue;
        const fit = fitRidge(tr.map((i) => [de[i]!]), tr.map((i) => dy[i]!), 0.01);
        for (const i of te) {
          model += Math.abs(fit.predict([de[i]!]) - dy[i]!);
          // The baseline is "no per-frame modulation": the shoot's own level,
          // i.e. deviation zero — exactly what a gated frame head emits.
          base += Math.abs(dy[i]!);
        }
      }
      per.push(base > 0 ? 1 - model / base : 0);
    }
    console.log(
      `  ${p.padEnd(16)} ${String(g.length).padStart(4)} ${String(shoots.length).padStart(6)}   ` +
        `${pooled.toFixed(3).padStart(8)}   ${(`${agree}/${shoots.length}`).padStart(12)}   ` +
        `${(`${mean(per).toFixed(4)} ±${sd(per).toFixed(4)}`).padStart(17)}   ${sd(dy).toFixed(2).padStart(6)}`,
    );
  }

  console.log(
    '\n  Skill is against "no per-frame modulation" — the shoot\'s own level, which is what\n' +
      '  the shipped model emits with the frame head gated. Shoots are held out whole.\n' +
      '  Trust the sign-agreement column over the pooled correlation.',
  );
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
