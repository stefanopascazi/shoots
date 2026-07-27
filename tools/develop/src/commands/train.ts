/**
 * `develop train` — fit and export a per-catalog develop profile.
 */
import { writeFile } from 'node:fs/promises';
import { train } from '../train/train.js';
import { loadDataset } from '../dataset/load.js';

export interface TrainArgs {
  data: string;
  name: string;
  out: string;
  /** 'auto' (cross-validated) or a numeric ridge strength. */
  lambda: string;
  folds: number;
}

export async function runTrain(args: TrainArgs): Promise<void> {
  const dataset = await loadDataset(args.data);
  const lambda = args.lambda === 'auto' ? undefined : parseFloat(args.lambda);
  if (lambda !== undefined && !Number.isFinite(lambda)) throw new Error(`invalid --lambda '${args.lambda}' (use a number or 'auto')`);

  const profile = train(dataset, { name: args.name, lambda, folds: args.folds });
  await writeFile(args.out, JSON.stringify(profile, null, 2) + '\n', 'utf8');

  const w = process.stderr;
  w.write(`\nDevelop profile '${profile.name}' → ${args.out}\n`);
  w.write(`  ${profile.stats.edited} edited images: ${profile.stats.color} colour + ${profile.stats.bw} B&W (${args.folds}-fold CV)\n`);

  for (const treatment of ['color', 'bw'] as const) {
    const b = profile.branches[treatment];
    if (!b) continue;
    w.write(`\n  ── ${treatment.toUpperCase()} branch — ${b.samples} images, λ=${b.ridgeLambda}${lambda === undefined ? ' (auto)' : ''} ──\n`);
    w.write(`  image-dependent skill: ${b.imageDependentSkill ?? 'n/a (too little data)'}\n`);
    const rows = b.perParam.filter((p) => p.weight >= 1.5 && p.baselineMae > 1e-6).sort((a, b2) => b2.skill - a.skill);
    if (rows.length > 0) {
      w.write('  param                model MAE   baseline MAE   skill\n');
      for (const p of rows) {
        w.write(`  ${p.key.padEnd(20)} ${p.modelMae.toFixed(3).padStart(9)} ${p.baselineMae.toFixed(3).padStart(14)} ${(p.skill * 100).toFixed(1).padStart(7)}%\n`);
      }
    }
  }
  w.write('\n  skill > 0 means the model beats "apply my average edit".\n');
}
