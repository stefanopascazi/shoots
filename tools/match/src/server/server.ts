/**
 * Local duel server. Serves the inline UI, hands out active-learning pairs,
 * records outcomes, and streams image bytes for display. State: the SQLite DB
 * plus an in-memory Elo used only for pair selection.
 */
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import express from 'express';
import type { Db } from '../db/database.js';
import { INDEX_HTML } from './ui.js';
import { allPhotos, getPhoto } from '../db/photos.js';
import { comparisonCounts, recordComparison, countComparisons } from '../db/comparisons.js';
import { initElo, applyOutcome, selectPair, type EloState } from '../pairing/elo.js';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

export interface ServeOptions {
  port: number;
  host: string;
}

export function createServer(db: Db): express.Express {
  const app = express();
  app.use(express.json());

  // Elo seeded once at startup from the neutral aesthetic + existing counts.
  const photos = allPhotos(db).map((p) => ({ id: p.id, clip_score: p.clip_score }));
  const elo: EloState = initElo(photos, comparisonCounts(db));

  app.get('/', (_req, res) => res.type('html').send(INDEX_HTML));

  app.get('/api/next-pair', (_req, res) => {
    res.json({ pair: selectPair(elo) });
  });

  app.post('/api/vote', (req, res) => {
    const { winnerId, loserId, session } = req.body ?? {};
    if (typeof winnerId !== 'number' || typeof loserId !== 'number' || winnerId === loserId) {
      return res.status(400).json({ error: 'winnerId and loserId must be distinct numbers' });
    }
    recordComparison(db, winnerId, loserId, typeof session === 'string' ? session : null);
    applyOutcome(elo, winnerId, loserId);
    res.json({ ok: true, comparisons: countComparisons(db) });
  });

  app.get('/api/image/:id', (req, res) => {
    const photo = getPhoto(db, Number(req.params.id));
    if (!photo) return res.status(404).end();
    // Prefer the browser-viewable preview from the bundle; fall back to the
    // original (works when it is itself a JPEG/PNG, not a RAW).
    const file = photo.preview_path && existsSync(photo.preview_path) ? photo.preview_path : photo.path;
    if (!existsSync(file)) return res.status(404).end();
    const mime = MIME[extname(file).toLowerCase()];
    if (!mime) return res.status(415).end(); // e.g. a RAW original with no preview
    res.type(mime);
    res.sendFile(file);
  });

  app.get('/api/stats', (_req, res) => {
    res.json({ photos: photos.length, comparisons: countComparisons(db) });
  });

  return app;
}

export function serve(db: Db, opts: ServeOptions): void {
  const app = createServer(db);
  app.listen(opts.port, opts.host, () => {
    // eslint-disable-next-line no-console
    console.log(`match: duel UI on http://${opts.host}:${opts.port}  (Ctrl+C to stop)`);
  });
}
