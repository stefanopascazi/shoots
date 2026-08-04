/**
 * shoot-gain — is the anchored correction's *intensity* predictable per shoot?
 *
 *   bun tools/shoot-gain/index.ts --data <develop-export.jsonl>
 *
 * An anchored slider is `ȳ + gain·(gap beyond a dead zone)`. The gain is fitted
 * once over the whole catalog, and `--anchor-gain` exists because that single
 * value is wrong for most shoots: fitted inside each shoot separately on the
 * reference catalog it runs from −0.04 to −2.61. Some weddings get their blown
 * frames rescued at two and a half stops per stop of excess; others are left
 * alone. One global number splits the difference and satisfies neither.
 *
 * If the gain can be predicted from something known about a shoot *before* it is
 * edited, then `--anchor-gain` stops being a knob the photographer calibrates by
 * eye and becomes a number the model computes. That is the whole question here.
 *
 * ## What makes this hard to measure honestly
 *
 * The obvious descriptor — how far the photographer moved this slider on average
 * across the shoot — is **circular**: the frames that set the shoot's average are
 * partly the same frames whose slope is being explained, and a steeper slope
 * drags the average down by itself. On the reference catalog that inflates the
 * correlation from 0.54 to 0.96.
 *
 * So every descriptor here is computed on the frames **inside or below** the dead
 * zone, disjoint from the ones the gain is fitted on.
 *
 * And a correlation is not the answer either. The decisive number is whether a
 * gain predicted for a shoot the fit has never seen beats the global one on that
 * shoot's frames — so the tool leaves each shoot out in turn, and reports the
 * oracle gain alongside as the ceiling any predictor could reach.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COLOR_FEATURE_NAMES } from '@shoots/imaging';
import { correlation, mean } from '../lib/fit.js';
import { fitAnchor } from '../../packages/cli/src/develop/train/anchor.js';
import { paramsForTreatment } from '../../packages/cli/src/develop/develop/schema.js';

/** Slider → the scene property it corrects against, mirroring train/anchor.ts. */
const ANCHORS: Record<string, { feature: string; log2?: boolean }> = {
  Exposure2012: { feature: 'lumaMean', log2: true },
  Highlights2012: { feature: 'lumaP99' },
  Whites2012: { feature: 'clipHigh' },
  Dehaze: { feature: 'detailCoarse' },
};

const EPS = 1e-9;

interface Frame {
  shoot: string;
  /** The anchor's scene property, log2'd where the spec asks. */
  x: number;
  /** The absolute slider value the photographer chose. */
  y: number;
  /** Every colour feature, for the shoot descriptors. */
  colour: number[];
}

/** Unshrunk least squares of y on x. */
function slope(rows: readonly { x: number; y: number }[]): number | null {
  if (rows.length < 3) return null;
  const mx = mean(rows.map((r) => r.x));
  const my = mean(rows.map((r) => r.y));
  let num = 0;
  let den = 0;
  for (const r of rows) {
    num += (r.x - mx) * (r.y - my);
    den += (r.x - mx) ** 2;
  }
  return den > EPS ? num / den : null;
}

interface ShootFit {
  name: string;
  gain: number;
  /** Frames the gain was fitted on. */
  above: Frame[];
  /** Frames it was not — where every descriptor is measured. */
  rest: Frame[];
}

/** Descriptors a shoot can be judged by, all from frames outside the gain fit. */
function describe(s: ShootFit, index: Record<string, number>): Record<string, number> {
  const rest = s.rest;
  const all = [...s.above, ...s.rest];
  return {
    // How far the photographer moved this slider on the frames that were already
    // close enough — the shoot's "level", and the one the model already predicts.
    level: mean(rest.map((f) => f.y)),
    shootLuma: mean(all.map((f) => f.colour[index.lumaMean!] ?? 0)),
    shootLumaP99: mean(all.map((f) => f.colour[index.lumaP99!] ?? 0)),
    blownFraction: s.above.length / Math.max(1, all.length),
    shootSat: mean(all.map((f) => f.colour[index.satMean!] ?? 0)),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const dataArg = argv[argv.indexOf('--data') + 1];
  if (argv.indexOf('--data') < 0 || !dataArg) {
    throw new Error('usage: bun tools/shoot-gain/index.ts --data <develop-export.jsonl> [--param Exposure2012] [--min-frames 5]');
  }
  const only = argv.includes('--param') ? argv[argv.indexOf('--param') + 1] : undefined;
  const minFrames = Number(argv[argv.indexOf('--min-frames') + 1] ?? 5) || 5;

  const records = readFileSync(path.resolve(dataArg), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r: any) => r.edited !== false && r.features?.length && r.develop);
  const index: Record<string, number> = {};
  COLOR_FEATURE_NAMES.forEach((n, i) => { index[n] = i; });
  console.log(`${records.length} edited frames, ${new Set(records.map((r: any) => path.dirname(r.file))).size} shoots\n`);

  for (const [param, spec] of Object.entries(ANCHORS)) {
    if (only && param !== only) continue;
    const fi = index[spec.feature];
    if (fi === undefined) continue;

    const frames: Frame[] = [];
    for (const r of records as any[]) {
      const raw = r.features[fi];
      const y = r.develop[param];
      if (!Number.isFinite(raw) || !Number.isFinite(y)) continue;
      if (spec.log2 && raw <= EPS) continue;
      frames.push({ shoot: path.dirname(r.file), x: spec.log2 ? Math.log2(raw) : raw, y, colour: r.features });
    }
    if (frames.length < 60) continue;

    // The dead zone comes from the shipped fitter, not from a local imitation of
    // it: a width chosen differently here would partition the frames differently
    // and the answer would be about this tool rather than about the model.
    const dp = paramsForTreatment('color').find((q) => q.key === param);
    if (!dp) continue;
    const fitted = fitAnchor(dp, spec, fi, frames.map((f) => ({ x: f.x, y: f.y, group: f.shoot })), {
      folds: 5, shuffles: 5, maeAllowance: 0.3,
    });
    if (!fitted) continue;
    const xbar = fitted.model.xbar;
    const deadband = fitted.model.deadband ?? 0;

    const byShoot = new Map<string, Frame[]>();
    for (const f of frames) {
      const a = byShoot.get(f.shoot) ?? [];
      a.push(f);
      byShoot.set(f.shoot, a);
    }
    const fits: ShootFit[] = [];
    for (const [name, fs] of byShoot) {
      const above = fs.filter((f) => f.x - xbar > deadband);
      const rest = fs.filter((f) => f.x - xbar <= deadband);
      if (above.length < minFrames || rest.length < 3) continue;
      const g = slope(above.map((f) => ({ x: f.x, y: f.y })));
      if (g === null) continue;
      fits.push({ name: path.basename(name), gain: g, above, rest });
    }

    console.log(`── ${param} (anchor ${spec.feature}${spec.log2 ? ', log2' : ''}, dead zone ${deadband.toFixed(3)}) ──`);
    if (fits.length < 6) {
      console.log(`  only ${fits.length} shoots carry ≥${minFrames} frames beyond the dead zone — not enough to say anything\n`);
      continue;
    }
    const gains = fits.map((f) => f.gain);
    const globalGain = slope(frames.filter((f) => f.x - xbar > deadband).map((f) => ({ x: f.x, y: f.y }))) ?? 0;
    console.log(`  ${fits.length} shoots · per-shoot gain ${Math.min(...gains).toFixed(2)} … ${Math.max(...gains).toFixed(2)} · global ${globalGain.toFixed(2)}`);

    // ── does any descriptor track the gain, measured off disjoint frames? ─────
    const descs = fits.map((f) => describe(f, index));
    const keys = Object.keys(descs[0]!);
    console.log('\n  descriptor          r with gain');
    const ranked = keys
      .map((k) => ({ k, r: correlation(gains, descs.map((d) => d[k]!)) }))
      .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    for (const { k, r } of ranked) console.log(`  ${k.padEnd(18)} ${r.toFixed(3).padStart(8)}`);

    // ── the decisive test: predict a held-out shoot's gain and use it ─────────
    // Correlation on a dozen points proves nothing on its own. This asks whether
    // a gain fitted without ever seeing a shoot beats the global one *on that
    // shoot's frames*, with the shoot's own gain as the ceiling.
    const bestKey = ranked[0]!.k;
    let errGlobal = 0;
    let errPredicted = 0;
    let errOracle = 0;
    let n = 0;
    for (let i = 0; i < fits.length; i++) {
      const train = fits.filter((_, j) => j !== i);
      const td = train.map((f) => describe(f, index)[bestKey]!);
      const tg = train.map((f) => f.gain);
      const b = slope(td.map((x, j) => ({ x, y: tg[j]! })));
      if (b === null) continue;
      const predicted = mean(tg) + b * (descs[i]![bestKey]! - mean(td));
      const globalTrain = mean(tg);
      const f = fits[i]!;
      const yb = mean(f.above.map((r) => r.y));
      const xb = mean(f.above.map((r) => r.x));
      for (const r of f.above) {
        errGlobal += Math.abs(yb + globalTrain * (r.x - xb) - r.y);
        errPredicted += Math.abs(yb + predicted * (r.x - xb) - r.y);
        errOracle += Math.abs(yb + f.gain * (r.x - xb) - r.y);
        n++;
      }
    }
    if (n > 0) {
      const skill = (e: number): string => `${((1 - e / errGlobal) * 100).toFixed(1)}%`;
      console.log(`\n  leave-one-shoot-out, gain predicted from "${bestKey}" (${n} frames):`);
      console.log(`    global gain           MAE ${(errGlobal / n).toFixed(4)}   (baseline)`);
      console.log(`    predicted per shoot   MAE ${(errPredicted / n).toFixed(4)}   ${skill(errPredicted)} better`);
      console.log(`    the shoot's own gain  MAE ${(errOracle / n).toFixed(4)}   ${skill(errOracle)} better  ← the ceiling`);
      console.log(
        '\n  If "predicted" beats "global" by a decent share of the ceiling, --anchor-gain\n' +
          '  can become a computed default. If it lands near the baseline, the intensity is\n' +
          "  irreducibly the photographer's and calibrating it once by eye is the right answer.\n",
      );
    }
  }
}

main();
