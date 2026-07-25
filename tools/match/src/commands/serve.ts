/** `match serve` — launch the local duel UI. */
import { openDatabase } from '../db/database.js';
import { countPhotos } from '../db/photos.js';
import { serve } from '../server/server.js';

export interface ServeArgs {
  db: string;
  port: number;
  host: string;
}

export async function runServe(args: ServeArgs): Promise<void> {
  const db = openDatabase(args.db);
  const n = countPhotos(db);
  if (n < 2) {
    db.close();
    throw new Error(`only ${n} photo(s) in ${args.db} — run 'match import' first`);
  }
  serve(db, { port: args.port, host: args.host });
}
