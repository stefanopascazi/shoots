/**
 * `match train --name <name> --out profiles/<name>.json`
 *
 * Reads the accumulated duels and photos, fits the linear-embedding profile, and
 * writes the deliverable JSON.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openDatabase } from '../db/database.js';
import { allPhotos, countPhotos, distinctModels } from '../db/photos.js';
import { allComparisons, countComparisons } from '../db/comparisons.js';
import { train } from '../ranking/train.js';

export interface TrainArgs {
  name: string;
  out: string;
  db: string;
  lambda: number;
  holdout: number;
}

export async function runTrain(args: TrainArgs): Promise<void> {
  const db = openDatabase(args.db);

  const models = distinctModels(db);
  if (models.length > 1) {
    db.close();
    throw new Error(`mixed embedding spaces in DB (${models.join(', ')}) — a profile needs one model`);
  }
  const photos = allPhotos(db);
  const comparisons = allComparisons(db);
  if (comparisons.length < 10) {
    db.close();
    throw new Error(`only ${comparisons.length} duels recorded — collect more via 'match serve' before training`);
  }
  const dim = photos[0]?.embedding.length ?? 0;
  const photoCount = countPhotos(db);
  const duelCount = countComparisons(db);

  const profile = train(
    {
      name: args.name,
      photos,
      comparisons,
      embeddingModel: models[0]!,
      dim,
      ridgeLambda: args.lambda,
    },
    { holdout: args.holdout },
  );

  db.close();

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(profile, null, 2) + '\n', 'utf8');

  const acc = profile.stats.heldOutPairAccuracy;
  console.log(`Trained '${args.name}' from ${duelCount} duels over ${photoCount} photos`);
  console.log(`  → ${args.out}  (dim ${dim}, model ${profile.embeddingModel})`);
  console.log(`  held-out pairwise accuracy: ${acc === null ? 'n/a (too few duels)' : acc}`);
}
