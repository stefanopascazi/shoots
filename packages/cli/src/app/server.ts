/**
 * The local app server: one inline page, a JSON API, thumbnails.
 *
 * It lives only as long as Lightroom does. The plug-in holds a lease by posting
 * to /api/host/heartbeat; when the lease lapses — Lightroom closed or crashed —
 * the server stops. Separately, when no page has been open for the idle window
 * and nothing is running, it stops too.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CullReport, JobRequest, JobStatus, LibraryPhoto, RateReport, RatingProfile } from '@shoots/app';
import { JobError, type JobRunner } from './jobs.js';
import { browse, type Library } from './library.js';
import { startIdleWatch, type IdleWatch } from './lifecycle.js';
import type { AppStore, PhotoLookup } from './store.js';
import {
  isAllowedHost,
  isAllowedOrigin,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  TOKEN_HEADER,
  tokenMatches,
} from './security.js';

export type StopReason = 'host-lease' | 'idle' | 'shutdown';

export interface AppServerOptions {
  html: string;
  token: string;
  info: { version: string; platform: string; home: string };
  library: Library;
  jobs: JobRunner;
  store: AppStore;
  profiles: () => Promise<RatingProfile[]>;
  /** Stop when the plug-in has not renewed its lease for this long. */
  hostLeaseMs: number;
  /** Stop when no page has checked in, and no job has run, for this long. */
  pageIdleMs: number;
  onStop: (reason: StopReason) => void;
}

export interface AppServer {
  server: Server;
  listen: (port: number) => Promise<number>;
  stop: (reason: StopReason) => void;
  /** Hand every finished job here: cull and rate results are stored for next time. */
  jobFinished: (status: JobStatus) => void;
}

// Room for a batch of decisions; anything larger is not something the page sends.
const MAX_BODY = 512 * 1024;

/** Maps a file path the CLI reported back to the photo that was listed, tolerating case on Windows. */
export function photoLookup(photos: readonly LibraryPhoto[], caseInsensitive: boolean): PhotoLookup {
  const exact = new Map(photos.map((p) => [p.path, p]));
  const folded = caseInsensitive ? new Map(photos.map((p) => [p.path.toLowerCase(), p])) : undefined;
  return (file) => exact.get(file) ?? folded?.get(file.toLowerCase());
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function createAppServer(opts: AppServerOptions): AppServer {
  let port = 0;
  let stopped = false;
  let hostLease: IdleWatch | undefined;
  let pageIdle: IdleWatch | undefined;
  /** The photos each running job was given, to store its results against. */
  const jobPhotos = new Map<string, LibraryPhoto[]>();
  /** A folder named on the launch URL; opened once, ahead of the remembered one. */
  let launchFolder: string | null = null;
  const caseInsensitive = process.platform === 'win32';

  const stop = (reason: StopReason): void => {
    if (stopped) return;
    stopped = true;
    hostLease?.stop();
    pageIdle?.stop();
    opts.jobs.stopAll();
    server.close();
    server.closeAllConnections?.();
    opts.onStop(reason);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
      return sendText(res, 403, 'Forbidden');
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';

    // The launch URL carries the token once; it becomes a cookie and leaves the address bar.
    if (url.pathname === '/' && method === 'GET') {
      const launch = url.searchParams.get('t');
      if (launch !== null) {
        if (!tokenMatches(launch, opts.token)) return sendText(res, 401, 'This link has expired. Open the app again from Lightroom.');
        launchFolder = url.searchParams.get('folder') || null;
        res.writeHead(303, { location: '/', 'set-cookie': sessionCookie(opts.token), 'cache-control': 'no-store' });
        return void res.end();
      }
      if (!authorized(req)) return sendText(res, 401, 'Open the app from Lightroom: Library › Plug-in Extras › Open shoots.');
      pageIdle?.touch();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      });
      return void res.end(opts.html);
    }

    if (!url.pathname.startsWith('/api/')) return sendText(res, 404, 'Not found');
    if (!authorized(req)) return sendJson(res, 401, { error: 'Not authorized.' });

    const route = `${method} ${url.pathname}`;
    switch (route) {
      case 'POST /api/host/heartbeat':
        hostLease?.touch();
        return sendJson(res, 200, { ok: true });
      case 'POST /api/heartbeat':
        pageIdle?.touch();
        return sendJson(res, 200, { ok: true, busy: opts.jobs.busy });
      case 'POST /api/shutdown':
        sendJson(res, 200, { ok: true });
        setImmediate(() => stop('shutdown'));
        return;
      case 'GET /api/info':
        return sendJson(res, 200, opts.info);
      case 'GET /api/profiles':
        return sendJson(res, 200, await opts.profiles());
      case 'GET /api/start': {
        // Everything the page needs to come back where it was left.
        const settings = opts.store.settings();
        const startFolder = launchFolder ?? (settings.reopenLastFolder ? settings.lastFolder : null);
        launchFolder = null;
        return sendJson(res, 200, { settings, startFolder, recent: opts.store.recentFolders() });
      }
      case 'GET /api/settings':
        return sendJson(res, 200, opts.store.settings());
      case 'PUT /api/settings':
        return withUserError(res, async () => opts.store.updateSettings(JSON.parse(await readBody(req))));
      case 'GET /api/folders/recent':
        return sendJson(res, 200, opts.store.recentFolders());
      case 'PUT /api/decisions':
        return putDecisions(req, res);
      case 'GET /api/browse':
        return withUserError(res, () => browse(url.searchParams.get('path')));
      case 'GET /api/library': {
        const folder = url.searchParams.get('folder');
        if (!folder) return sendJson(res, 400, { error: 'Choose a folder.' });
        return withUserError(res, async () => {
          const listing = await opts.library.list(folder, url.searchParams.get('recursive') === '1');
          opts.store.openedFolder(listing.folder, listing.recursive);
          return { ...listing, ...opts.store.resultsFor(listing.photos) };
        });
      }
      case 'GET /api/thumb':
        return thumb(res, url);
      case 'POST /api/jobs':
        return startJob(req, res);
    }

    const job = /^\/api\/jobs\/([\w-]+)$/.exec(url.pathname);
    if (job && method === 'GET') {
      const status = opts.jobs.get(job[1]);
      return status ? sendJson(res, 200, status) : sendJson(res, 404, { error: 'No such job.' });
    }
    if (job && method === 'DELETE') {
      const status = opts.jobs.cancel(job[1]);
      return status ? sendJson(res, 200, status) : sendJson(res, 404, { error: 'No such job.' });
    }
    return sendJson(res, 404, { error: 'Not found.' });
  }

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers[TOKEN_HEADER];
    const candidate = typeof header === 'string' ? header : readCookie(req.headers.cookie, SESSION_COOKIE);
    return tokenMatches(candidate, opts.token);
  }

  async function thumb(res: ServerResponse, url: URL): Promise<void> {
    const file = url.searchParams.get('path');
    if (!file || !opts.library.isServable(file)) return sendJson(res, 404, { error: 'Not found.' });
    const width = Math.min(1600, Math.max(64, Number(url.searchParams.get('w')) || 400));
    try {
      const buf = await opts.library.thumbnail(file, width);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'private, max-age=3600' });
      res.end(buf);
    } catch (err) {
      sendJson(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function startJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = parseJobRequest(await readBody(req));
    if (!request) return sendJson(res, 400, { error: 'Unknown job.' });
    try {
      const photos = request.folder ? await opts.library.photosOf(request.folder, request.recursive === true) : [];
      pageIdle?.touch();
      const status = opts.jobs.start(request, photos.map((p) => p.path));
      jobPhotos.set(status.id, photos);
      sendJson(res, 202, status);
    } catch (err) {
      sendJson(res, err instanceof JobError ? err.status : 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Body: `{ decisions: { [path]: 'keep' | 'reject' | null } }`. Only photographs in an opened folder. */
  async function putDecisions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { decisions?: Record<string, unknown> };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Not a list of decisions.' });
    }
    const entries = Object.entries(body.decisions ?? {});
    let saved = 0;
    for (const [path, d] of entries) {
      if (!opts.library.isServable(path)) continue;
      if (d !== 'keep' && d !== 'reject' && d !== null) continue;
      opts.store.setDecision(path, d);
      saved++;
    }
    sendJson(res, 200, { saved });
  }

  function jobFinished(status: JobStatus): void {
    const photos = jobPhotos.get(status.id);
    jobPhotos.delete(status.id);
    if (!photos || status.state !== 'done') return;
    const lookup = photoLookup(photos, caseInsensitive);
    if (status.kind === 'cull') opts.store.saveResults('cull', (status.result as CullReport).results ?? [], lookup);
    if (status.kind === 'rate') {
      const report = status.result as RateReport;
      opts.store.saveResults('rate', report.results ?? [], lookup, report.profile);
    }
  }

  return {
    server,
    stop,
    jobFinished,
    listen: (requested) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requested, '127.0.0.1', () => {
          const addr = server.address();
          port = typeof addr === 'object' && addr ? addr.port : requested;
          hostLease = startIdleWatch(opts.hostLeaseMs, () => false, () => stop('host-lease'));
          pageIdle = startIdleWatch(opts.pageIdleMs, () => opts.jobs.busy, () => stop('idle'));
          resolve(port);
        });
      }),
  };
}

export function parseJobRequest(body: string): JobRequest | undefined {
  let raw: Partial<JobRequest>;
  try {
    raw = JSON.parse(body) as Partial<JobRequest>;
  } catch {
    return undefined;
  }
  if (raw.kind !== 'cull' && raw.kind !== 'rate' && raw.kind !== 'doctor') return undefined;
  if (raw.kind !== 'doctor' && typeof raw.folder !== 'string') return undefined;
  return {
    kind: raw.kind,
    folder: typeof raw.folder === 'string' ? raw.folder : undefined,
    recursive: raw.recursive === true,
    profile: typeof raw.profile === 'string' && /^[\w.-]+$/.test(raw.profile) ? raw.profile : undefined,
  };
}

async function withUserError(res: ServerResponse, work: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, 200, await work());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT' ? 'That folder does not exist.' : code === 'EACCES' || code === 'EPERM' ? 'That folder cannot be read.' : err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
