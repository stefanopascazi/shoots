/**
 * Reads the accumulated duels and photos, fits the linear-embedding profile, and
 * writes the deliverable JSON.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openDatabase } from '../db/database.js';
import { allPhotos, countPhotos, distinctModels } from '../db/photos.js';
import { allComparisons, countComparisons } from '../db/comparisons.js';
import { train } from '../ranking/train.js';
import type { LinearEmbeddingProfile } from '../types.js';

/** Below this the fit is noise, not taste. */
export const MIN_DUELS = 10;

export interface TrainArgs {
  name: string;
  out: string;
  db: string;
  lambda: number;
  holdout: number;
}

export interface TrainResult {
  profile: LinearEmbeddingProfile;
  out: string;
  duels: number;
  photos: number;
  dim: number;
  embeddingModel: string;
  heldOutPairAccuracy: number | null;
}

export async function runTrain(args: TrainArgs): Promise<TrainResult> {
  const db = await openDatabase(args.db);

  const models = distinctModels(db);
  if (models.length > 1) {
    db.close();
    throw new Error(
      `mixed embedding spaces in DB (${models.join(', ')}) — a profile needs one model`,
    );
  }
  const photos = allPhotos(db);
  const comparisons = allComparisons(db);
  if (comparisons.length < MIN_DUELS) {
    db.close();
    throw new Error(
      `only ${comparisons.length} duels recorded — collect more via 'shoots match serve' before training`,
    );
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

  return {
    profile,
    out: args.out,
    duels: duelCount,
    photos: photoCount,
    dim,
    embeddingModel: profile.embeddingModel,
    heldOutPairAccuracy: profile.stats.heldOutPairAccuracy,
  };
}
