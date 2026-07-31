/** Opens the DB and starts the local duel UI. */
import type { Server } from 'node:http';
import { openDatabase } from '../db/database.js';
import { countPhotos } from '../db/photos.js';
import { countComparisons } from '../db/comparisons.js';
import { serve } from '../server/server.js';

export interface ServeArgs {
  db: string;
  port: number;
  host: string;
}

export interface ServeResult {
  server: Server;
  url: string;
  photos: number;
  comparisons: number;
}

export async function runServe(args: ServeArgs): Promise<ServeResult> {
  const db = await openDatabase(args.db);
  const photos = countPhotos(db);
  if (photos < 2) {
    db.close();
    throw new Error(`only ${photos} photo(s) in ${args.db} — run 'shoots match import' first`);
  }

  const comparisons = countComparisons(db);
  const server = await serve(db, { port: args.port, host: args.host });

  return { server, url: `http://${args.host}:${args.port}`, photos, comparisons };
}
