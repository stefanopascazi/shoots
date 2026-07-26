/**
 * `develop train` — fit and export a per-catalog develop profile.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { train } from '../train/train.js';
import type { DevelopDataset } from '../types.js';

export interface TrainArgs {
  data: string;
  name: string;
  out: string;
  lambda: number;
  holdout: number;
}

export async function runTrain(args: TrainArgs): Promise<void> {
  const dataset = JSON.parse(await readFile(args.data, 'utf8')) as DevelopDataset;
  if (dataset.command !== 'develop-export') {
    throw new Error(`'${args.data}' is not a develop-export dataset (command: ${String(dataset.command)})`);
  }
  const profile = train(dataset, { name: args.name, lambda: args.lambda, holdout: args.holdout });
  await writeFile(args.out, JSON.stringify(profile, null, 2) + '\n', 'utf8');

  const s = profile.stats;
  process.stderr.write(`\nDevelop profile '${profile.name}' → ${args.out}\n`);
  process.stderr.write(`  ${s.withDevelop}/${s.samples} images with develop settings, ${s.heldOut} held out\n`);
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
