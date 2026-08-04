/**
 * Local duel server. Serves the inline UI, hands out active-learning pairs,
 * records outcomes, and streams image bytes for display. State: the SQLite DB
 * plus an in-memory Elo used only for pair selection.
 *
 * Built on `node:http` rather than a framework: five routes do not justify a
 * dependency, and the standalone binary should carry as little as possible.
 * The page itself is a string constant (see `ui.ts`), so there is nothing to
 * extract to disk at runtime — it compiles into the binary like any other code.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname } from 'node:path';
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

/** Refuse absurd bodies rather than buffering whatever is sent. */
const MAX_BODY_BYTES = 4096;

export interface ServeOptions {
  port: number;
  host: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendImage(res: ServerResponse, file: string): void {
  const mime = MIME[extname(file).toLowerCase()];
  // e.g. a RAW original whose bundle carried no preview — nothing a browser can show.
  if (!mime) {
    res.writeHead(415).end();
    return;
  }

  res.writeHead(200, { 'content-type': mime, 'content-length': statSync(file).size });
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function createServer(db: Db): Server {
  // Elo seeded once at startup from the neutral aesthetic + existing counts.
  const photos = allPhotos(db).map((p) => ({ id: p.id, clip_score: p.clip_score }));
  const elo: EloState = initElo(photos, comparisonCounts(db));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (method === 'GET' && pathname === '/api/next-pair') {
      sendJson(res, 200, { pair: selectPair(elo) });
      return;
    }

    if (method === 'POST' && pathname === '/api/vote') {
      const body = (await readJsonBody(req)) as
        | { winnerId?: unknown; loserId?: unknown; session?: unknown }
        | undefined;
      const { winnerId, loserId, session } = body ?? {};
      if (typeof winnerId !== 'number' || typeof loserId !== 'number' || winnerId === loserId) {
        sendJson(res, 400, { error: 'winnerId and loserId must be distinct numbers' });
        return;
      }
      recordComparison(db, winnerId, loserId, typeof session === 'string' ? session : null);
      applyOutcome(elo, winnerId, loserId);
      sendJson(res, 200, { ok: true, comparisons: countComparisons(db) });
      return;
    }

    if (method === 'GET' && pathname.startsWith('/api/image/')) {
      const photo = getPhoto(db, Number(pathname.slice('/api/image/'.length)));
      if (!photo) {
        res.writeHead(404).end();
        return;
      }
      // Prefer the browser-viewable preview from the bundle; fall back to the
      // original (works when it is itself a JPEG/PNG, not a RAW).
      const file =
        photo.preview_path && existsSync(photo.preview_path) ? photo.preview_path : photo.path;
      if (!existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      sendImage(res, file);
      return;
    }

    if (method === 'GET' && pathname === '/api/stats') {
      sendJson(res, 200, { photos: photos.length, comparisons: countComparisons(db) });
      return;
    }

    res.writeHead(404).end();
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: 'internal error' });
    });
  });
}

/**
 * Starts the server and resolves once it is accepting connections.
 *
 * A busy port is the one failure a caller will actually hit, and node's raw
 * `EADDRINUSE` names neither the port nor the flag that changes it. Unlike the
 * develop review screen this one does *not* fall back to a free port: the
 * address was asked for by name, and quietly serving somewhere else would leave
 * a bookmark pointing at nothing.
 */
export function serve(db: Db, opts: ServeOptions): Promise<Server> {
  const server = createServer(db);
  return new Promise((listening, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`port ${opts.port} is already in use — pass a free --port`));
      } else if (e.code === 'EACCES') {
        reject(new Error(`not allowed to open port ${opts.port} — ports below 1024 need privileges; pass a higher --port`));
      } else {
        reject(e);
      }
    });
    server.listen(opts.port, opts.host, () => listening(server));
  });
}
