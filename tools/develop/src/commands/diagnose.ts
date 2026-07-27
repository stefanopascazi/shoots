/**
 * `develop diagnose` — style-clustering diagnostic (pooled vs per-style skill).
 */
import { diagnose } from '../diagnose/diagnose.js';
import { loadDataset } from '../dataset/load.js';

export interface DiagnoseArgs {
  data: string;
  folds: number;
  maxK: number;
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export async function runDiagnose(args: DiagnoseArgs): Promise<void> {
  const dataset = await loadDataset(args.data);
  const r = diagnose(dataset, { folds: args.folds, maxK: args.maxK });

  const w = process.stderr;
  w.write(`\nStyle-clustering diagnostic — ${r.edited} edited images (${args.folds}-fold CV)\n`);
  w.write(`  POOLED (one model)          image-dependent skill: ${pct(r.pooledSkill)}\n`);
  for (const k of r.perK) {
    w.write(`\n  CLUSTERED k=${k.k} (oracle routing) skill: ${pct(k.clusteredSkill)}\n`);
    for (const c of k.clusters) {
      const bw = c.bwFraction === null ? '' : `  B&W ${(c.bwFraction * 100).toFixed(0)}%`;
      w.write(
        `    n=${String(c.size).padStart(4)}  curveContrast ${c.curveContrast.toFixed(2).padStart(5)}  blackLift ${c.blackLift.toFixed(2).padStart(4)}  Sat ${String(c.meanSaturation).padStart(4)}  Contrast ${String(c.meanContrast).padStart(4)}  Exp ${c.meanExposure.toFixed(2).padStart(5)}${bw}\n`,
      );
    }
  }
  w.write('\n  If CLUSTERED skill ≫ POOLED, conditioning on style is the lever:\n');
  w.write('  a single linear model is averaging incompatible looks. (Oracle routing =\n');
  w.write('  upper bound; predicting the style from content/human pick is a separate step.)\n');
}
