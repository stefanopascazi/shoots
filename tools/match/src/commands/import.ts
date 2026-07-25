/**
 * `match import --data dataset.json [--images <dir>]`
 *
 * Loads a `shoots embeddings --json` dataset into SQLite. Idempotent on path, so
 * re-importing an updated dataset refreshes embeddings without duplicating rows.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase } from '../db/database.js';
import { upsertPhoto, countPhotos } from '../db/photos.js';
import type { Dataset } from '../types.js';

export interface ImportArgs {
  data: string;
  images?: string;
  db: string;
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

export async function runImport(args: ImportArgs): Promise<void> {
  const raw = JSON.parse(await readFile(args.data, 'utf8')) as Dataset;
  if (raw.command !== 'embeddings' || !Array.isArray(raw.results)) {
    throw new Error(`${args.data} is not a 'shoots embeddings' dataset`);
  }

  const db = openDatabase(args.db);
  const before = countPhotos(db);

  // Wrap the bulk load in a single transaction (fast, all-or-nothing).
  db.exec('BEGIN');
  try {
    for (const r of raw.results) {
      if (!Array.isArray(r.embedding) || r.embedding.length !== raw.dim) {
        throw new Error(`bad embedding for ${r.file} (expected dim ${raw.dim})`);
      }
      upsertPhoto(db, {
        path: resolvePath(r.file, args.images),
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

  const after = countPhotos(db);
  db.close();
  console.log(
    `Imported ${raw.results.length} photos from ${args.data} (model ${raw.model}, dim ${raw.dim}) → ${args.db}`,
  );
  console.log(`Photos in DB: ${after} (${after - before} new)`);
}
