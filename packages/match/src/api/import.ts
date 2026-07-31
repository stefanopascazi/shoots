/**
 * Loads a `shoots embeddings` dataset into SQLite. Idempotent on path, so
 * re-importing an updated dataset refreshes embeddings without duplicating rows
 * and without losing a single recorded duel.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase } from '../db/database.js';
import { upsertPhoto, countPhotos } from '../db/photos.js';
import type { Dataset } from '../types.js';

export interface ImportArgs {
  data: string;
  images?: string;
  db: string;
}

export interface ImportResult {
  db: string;
  data: string;
  model: string;
  dim: number;
  imported: number;
  total: number;
  added: number;
}

/** Resolve an image path, optionally rebased under --images for portable datasets. */
function resolvePath(file: string, imagesDir?: string): string {
  if (imagesDir && !isAbsolute(file)) return resolve(imagesDir, file);
  if (imagesDir && !existsSync(file)) {
    const rebased = resolve(imagesDir, file.replace(/^.*[\\/]/, ''));
    if (existsSync(rebased)) return rebased;
  }
  return resolve(file);
}

export async function runImport(args: ImportArgs): Promise<ImportResult> {
  const raw = JSON.parse(await readFile(args.data, 'utf8')) as Dataset;
  if (raw.command !== 'embeddings' || !Array.isArray(raw.results)) {
    throw new Error(`${args.data} is not a 'shoots embeddings' dataset`);
  }

  // Bundle previews are stored relative to the dataset file; resolve against it.
  const datasetDir = dirname(resolve(args.data));

  const db = await openDatabase(args.db);
  const before = countPhotos(db);

  // Wrap the bulk load in a single transaction (fast, all-or-nothing).
  db.exec('BEGIN');
  try {
    for (const r of raw.results) {
      if (!Array.isArray(r.embedding) || r.embedding.length !== raw.dim) {
        throw new Error(`bad embedding for ${r.file} (expected dim ${raw.dim})`);
      }
      const previewPath = r.preview ? resolve(datasetDir, r.preview) : null;
      upsertPhoto(db, {
        path: resolvePath(r.file, args.images),
        previewPath,
        model: raw.model,
        embedding: r.embedding,
        clipScore: r.aestheticSeed,
        aspects: r.aspects,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }

  const total = countPhotos(db);
  db.close();

  return {
    db: args.db,
    data: args.data,
    model: raw.model,
    dim: raw.dim,
    imported: raw.results.length,
    total,
    added: total - before,
  };
}
