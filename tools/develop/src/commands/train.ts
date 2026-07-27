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

  const s = profile.stats;
  process.stderr.write(`\nDevelop profile '${profile.name}' → ${args.out}\n`);
  process.stderr.write(`  ${s.withDevelop}/${s.samples} images with develop settings, ${s.heldOut} held out (${args.folds}-fold CV)\n`);
  process.stderr.write(`  ridge λ: ${profile.ridgeLambda}${lambda === undefined ? ' (auto)' : ''}\n`);
  process.stderr.write(`  image-dependent skill: ${s.imageDependentSkill ?? 'n/a (too little held-out data)'}\n`);

  if (s.perParam.length > 0) {
    // Show the image-dependent params, best skill first — the go/no-go evidence.
    const rows = s.perParam
      .filter((p) => p.weight >= 1.5)
      .sort((a, b) => b.skill - a.skill);
    process.stderr.write('\n  param                model MAE   baseline MAE   skill\n');
    for (const p of rows) {
      process.stderr.write(
        `  ${p.key.padEnd(20)} ${p.modelMae.toFixed(3).padStart(9)} ${p.baselineMae.toFixed(3).padStart(14)} ${(p.skill * 100).toFixed(1).padStart(7)}%\n`,
      );
    }
    process.stderr.write('\n  skill > 0 means the model beats "apply my average edit".\n');
  }
}
