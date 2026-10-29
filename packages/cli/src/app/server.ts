/**
 * The local app server: one inline page, a JSON API, thumbnails.
 *
 * It lives only as long as Lightroom does. The plug-in holds a lease by posting
 * to /api/host/heartbeat; when the lease lapses — Lightroom closed or crashed —
 * the server stops. Separately, when no page has been open for the idle window
 * and nothing is running, it stops too.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  changeFor,
  COLOR_LABELS,
  RESET_PARTS,
  sanitizeMarksPatch,
  sendStatus,
  type CullReport,
  type JobKind,
  type JobRequest,
  type JobStatus,
  type LibraryPhoto,
  type ColorLabel,
  type DevelopStatus,
  type LightroomChange,
  type LightroomError,
  type LightroomState,
  type RateReport,
  type RatingProfile,
  type ResetPart,
  type SyncWatch,
} from '@shoots/app';
import { JobError, type JobRunner } from './jobs.js';
import { DURABLE_KINDS, type DurableJobs } from './durableJobs.js';
import { parseCleanupParts, type Cleanup } from './cleanup.js';
import { parseCatalogExport } from '../develop/adapters/lightroom/catalog.js';
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
  /** Training and calibration, which outlive the server. */
  durable: DurableJobs;
  store: AppStore;
  developStatus: () => Promise<DevelopStatus>;
  /** Training output and the app's job history, removable from Setup. */
  cleanup: Cleanup;
  profiles: () => Promise<RatingProfile[]>;
  /** Stop when the plug-in has not renewed its lease for this long. */
  hostLeaseMs: number;
  /** Told when a training, calibration or export check starts. */
  onDurableStart?: (status: JobStatus) => void;
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

// Room for a batch of marks; anything larger is not something the page sends.
const MAX_BODY = 512 * 1024;
// A catalog export carries every photo's develop settings, a few kB each.
const MAX_CATALOG_BODY = 256 * 1024 * 1024;

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
  // The calibration page, served by `develop calibrate --review` on its own port.
  'frame-src http://127.0.0.1:*',
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
  /** The folder open in the page, which the plug-in follows in the catalog. */
  let watched: SyncWatch | null = null;
  /** Bumped whenever Lightroom changes something the page shows, so the page knows to look again. */
  let revision = 0;
  let lightroomSeenAt: number | null = null;
  /** The last failure the plug-in reported from its lease loop, for the page to show. */
  let lightroomError: LightroomError | null = null;
  const caseInsensitive = process.platform === 'win32';

  const stop = (reason: StopReason): void => {
    if (stopped) return;
    stopped = true;
    hostLease?.stop();
    pageIdle?.stop();
    opts.jobs.stopAll();
    // Training already running goes on without us; one still waiting for Lightroom cannot.
    opts.durable.release();
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
        // The plug-in collects the outbox when this says there is something in it,
        // and reads back from the catalog the folder the page has open.
        // and exports the catalog for a training that waits on it.
        return sendJson(res, 200, {
          ok: true,
          pending: opts.store.pendingCount(),
          watch: watched,
          export: opts.durable.awaitingCatalog() ?? null,
        });
      case 'POST /api/catalog/export':
        return takeCatalogExport(req, res, url);
      case 'POST /api/lightroom/state':
        return takeLightroomState(req, res);
      case 'GET /api/sync':
        return sendJson(res, 200, { revision, following: watched !== null && lightroomSeenAt !== null, lightroomError });
      case 'POST /api/host/error':
        return takeHostError(req, res);
      case 'POST /api/catalog/progress': {
        // The plug-in reading a folder for a job: renews the lease while the loop is busy.
        hostLease?.touch();
        const done = Number(url.searchParams.get('done'));
        const total = Number(url.searchParams.get('total'));
        const id = url.searchParams.get('job');
        if (id && Number.isFinite(done) && Number.isFinite(total)) opts.durable.catalogProgress(id, done, total);
        return sendJson(res, 200, { ok: true });
      }
      case 'GET /api/outbox':
        return sendJson(res, 200, { items: opts.store.pending() });
      case 'POST /api/outbox':
        return sendToLightroom(req, res);
      case 'POST /api/outbox/ack':
        return ackOutbox(req, res);
      case 'GET /api/outbox/state': {
        const folder = url.searchParams.get('folder');
        return folder ? sendJson(res, 200, opts.store.sentUnder(folder)) : sendJson(res, 400, { error: 'Choose a folder.' });
      }
      case 'POST /api/heartbeat':
        pageIdle?.touch();
        return sendJson(res, 200, { ok: true, busy: busy() });
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
      case 'PUT /api/marks':
        return putMarks(req, res);
      case 'POST /api/reset':
        return resetPhotos(req, res);
      case 'DELETE /api/memory':
        // Forgets what the app knows. Lightroom keeps whatever was already sent to it.
        opts.store.clearAll();
        launchFolder = null;
        watched = null;
        return sendJson(res, 200, { ok: true });
      case 'GET /api/browse':
        return withUserError(res, () => browse(url.searchParams.get('path')));
      case 'GET /api/library': {
        const folder = url.searchParams.get('folder');
        if (!folder) return sendJson(res, 400, { error: 'Choose a folder.' });
        return withUserError(res, async () => {
          const listing = await opts.library.list(folder, url.searchParams.get('recursive') === '1');
          opts.store.openedFolder(listing.folder, listing.recursive);
          if (watched?.folder !== listing.folder || watched.recursive !== listing.recursive) lightroomSeenAt = null;
          watched = { folder: listing.folder, recursive: listing.recursive };
          return { ...listing, ...opts.store.resultsFor(listing.photos) };
        });
      }
      case 'GET /api/thumb':
        return thumb(res, url);
      case 'POST /api/jobs':
        return startJob(req, res);
      case 'GET /api/jobs/training':
        return sendJson(res, 200, { job: opts.durable.latest() ?? null });
      case 'GET /api/develop/status':
        return withUserError(res, () => opts.developStatus());
      case 'GET /api/cleanup':
        return withUserError(res, async () => ({ items: await opts.cleanup.preview() }));
      case 'POST /api/cleanup':
        return cleanUp(req, res);
    }

    const job = /^\/api\/jobs\/([\w-]+)$/.exec(url.pathname);
    if (job && method === 'GET') {
      const status = opts.jobs.get(job[1]) ?? opts.durable.get(job[1]);
      return status ? sendJson(res, 200, status) : sendJson(res, 404, { error: 'No such job.' });
    }
    if (job && method === 'DELETE') {
      const status = opts.jobs.cancel(job[1]) ?? opts.durable.cancel(job[1]);
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
    if (busy()) return sendJson(res, 409, { error: 'Another job is still running.' });
    try {
      if (DURABLE_KINDS.has(request.kind)) {
        pageIdle?.touch();
        const started = opts.durable.start(request);
        opts.onDurableStart?.(started);
        return sendJson(res, 202, started);
      }
      const photos = request.folder ? await opts.library.photosOf(request.folder, request.recursive === true) : [];
      pageIdle?.touch();
      const status = opts.jobs.start(request, photos.map((p) => p.path));
      jobPhotos.set(status.id, photos);
      sendJson(res, 202, status);
    } catch (err) {
      sendJson(res, err instanceof JobError ? err.status : 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Body: `{ marks: { [path]: { flag?, stars?, label? } } }`, a null field handing it back to shoots.
   * Only photographs in an opened folder. Replies with each photo's marks as they now stand.
   */
  async function putMarks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { marks?: Record<string, unknown> };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Not a set of marks.' });
    }
    const marks: Record<string, unknown> = {};
    for (const [path, patch] of Object.entries(body.marks ?? {})) {
      if (!opts.library.isServable(path)) continue;
      marks[path] = opts.store.setMarks(path, sanitizeMarksPatch(patch)) ?? null;
    }
    sendJson(res, 200, { marks });
  }

  /** The photos a request names: a folder as listed, narrowed to `paths` when given. */
  async function photosIn(body: { folder?: unknown; recursive?: unknown; paths?: unknown }): Promise<LibraryPhoto[]> {
    if (typeof body.folder !== 'string') throw new Error('Choose a folder.');
    const only = Array.isArray(body.paths) ? new Set(body.paths.filter((p): p is string => typeof p === 'string')) : undefined;
    const listing = await opts.library.list(body.folder, body.recursive === true);
    return only ? listing.photos.filter((p) => only.has(p.path)) : listing.photos;
  }

  /** Body: `{ folder, recursive?, paths?, parts }`. Forgets those parts in the app; Lightroom is not touched. */
  async function resetPhotos(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { folder?: unknown; recursive?: unknown; paths?: unknown; parts?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Nothing to reset.' });
    }
    const parts = Array.isArray(body.parts) ? body.parts.filter((p): p is ResetPart => RESET_PARTS.includes(p as ResetPart)) : [];
    if (parts.length === 0) return sendJson(res, 400, { error: 'Choose what to reset.' });
    await withUserError(res, async () => {
      const photos = await photosIn(body);
      return { reset: opts.store.reset(photos.map((p) => p.path), parts) };
    });
  }

  /** Body: `{ folder, recursive?, paths? }`. Queues what the folder (or those photos) should carry into Lightroom. */
  async function sendToLightroom(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { folder?: unknown; recursive?: unknown; paths?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Nothing to send.' });
    }
    await withUserError(res, async () => {
      const photos = await photosIn(body);
      const known = opts.store.resultsFor(photos);
      const lookup = photoLookup(photos, caseInsensitive);
      const cullOf = new Map(known.cull.map((c) => [lookup(c.file)?.path ?? c.file, c]));
      const starsOf = new Map(known.rate.map((r) => [lookup(r.file)?.path ?? r.file, r.stars]));
      const changes: LightroomChange[] = [];
      for (const p of photos) {
        const change = changeFor(p.path, cullOf.get(p.path), starsOf.get(p.path), known.marks[p.path]);
        const status = sendStatus(change, known.sent[p.path]);
        // Already on its way or already in the catalog as it stands: nothing new to send.
        if (change && status !== 'pending' && status !== 'applied') changes.push(change);
      }
      return { queued: opts.store.enqueue(changes) };
    });
  }

  /** Body: `{ applied: id[], missing: id[] }` from the plug-in. */
  async function ackOutbox(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { applied?: unknown; missing?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Not an acknowledgement.' });
    }
    const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);
    const settled = opts.store.settle(ids(body.applied), ids(body.missing));
    if (settled) revision++;
    sendJson(res, 200, { settled });
  }

  /**
   * Body: `{ folder, photos: [{ path, rating, pick, label }] }` — what the catalog
   * holds for photos of the watched folder (all of them on a first report, then
   * only those that changed). Paths are matched to the folder as listed.
   */
  async function takeLightroomState(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { folder?: unknown; photos?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Not a Lightroom report.' });
    }
    if (!watched || body.folder !== watched.folder || !Array.isArray(body.photos)) return sendJson(res, 200, { changed: 0 });
    await withUserError(res, async () => {
      const listing = await opts.library.list(watched!.folder, watched!.recursive);
      const lookup = photoLookup(listing.photos, caseInsensitive);
      const states: LightroomState[] = [];
      for (const raw of body.photos as unknown[]) {
        const state = parseLightroomState(raw);
        const photo = state && lookup(state.path);
        if (state && photo) states.push({ ...state, path: photo.path });
      }
      const changed = opts.store.syncFromLightroom(states);
      lightroomSeenAt = Date.now();
      if (changed) revision++;
      return { changed };
    });
  }

  /** Body: `{ parts }`. Refused while a job runs: it may be writing what would be removed. */
  async function cleanUp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parts;
    try {
      parts = parseCleanupParts((JSON.parse(await readBody(req)) as { parts?: unknown }).parts);
    } catch {
      return sendJson(res, 400, { error: 'Choose what to remove.' });
    }
    if (parts.length === 0) return sendJson(res, 400, { error: 'Choose what to remove.' });
    if (busy()) return sendJson(res, 409, { error: 'A job is running. Wait for it to end, or stop it.' });
    await withUserError(res, async () => ({ removed: await opts.cleanup.run(parts) }));
  }

  /** Body: `{ where, message }` — a step of the plug-in's lease loop failed. */
  async function takeHostError(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { where?: unknown; message?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Not an error report.' });
    }
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    lightroomError = { where: text(body.where, 80), message: text(body.message, 600), at: Date.now() };
    process.stderr.write(`plug-in: ${lightroomError.where}: ${lightroomError.message}\n`);
    sendJson(res, 200, { ok: true });
  }

  /** Either runner at work: one job at a time across both. */
  function busy(): boolean {
    return opts.jobs.busy || opts.durable.busy;
  }

  /** Body: the plug-in's catalog export for the training named by `?job=`. Starts the run. */
  async function takeCatalogExport(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const id = url.searchParams.get('job');
    if (!id) return sendJson(res, 400, { error: 'Name the job.' });
    let text: string;
    try {
      text = await readBody(req, MAX_CATALOG_BODY);
      parseCatalogExport(text);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      sendJson(res, 200, await opts.durable.provideCatalog(id, text));
    } catch (err) {
      sendJson(res, err instanceof JobError ? err.status : 400, { error: err instanceof Error ? err.message : String(err) });
    }
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
          pageIdle = startIdleWatch(opts.pageIdleMs, busy, () => stop('idle'));
          resolve(port);
        });
      }),
  };
}

/** One photo of a Lightroom report, or undefined when it is not well formed. */
export function parseLightroomState(raw: unknown): LightroomState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== 'string' || !Number.isInteger(r.rating) || (r.rating as number) < 0 || (r.rating as number) > 5) return undefined;
  if (r.pick !== -1 && r.pick !== 0 && r.pick !== 1) return undefined;
  if (!COLOR_LABELS.includes(r.label as ColorLabel)) return undefined;
  return { path: r.path, rating: r.rating as number, pick: r.pick, label: r.label as ColorLabel };
}

const JOB_KINDS: readonly JobKind[] = ['cull', 'rate', 'doctor', 'train', 'calibrate', 'catalog'];
const NEEDS_FOLDER: ReadonlySet<JobKind> = new Set<JobKind>(['cull', 'rate', 'train', 'catalog']);

export function parseJobRequest(body: string): JobRequest | undefined {
  let raw: Partial<JobRequest>;
  try {
    raw = JSON.parse(body) as Partial<JobRequest>;
  } catch {
    return undefined;
  }
  if (!JOB_KINDS.includes(raw.kind as JobKind)) return undefined;
  if (NEEDS_FOLDER.has(raw.kind as JobKind) && typeof raw.folder !== 'string') return undefined;
  return {
    kind: raw.kind as JobKind,
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

function readBody(req: IncomingMessage, limit: number = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
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
