/**
 * The local app server: one inline page, a JSON API, thumbnails.
 *
 * It lives only as long as Lightroom does. The plug-in holds a lease by posting
 * to /api/host/heartbeat; when the lease lapses — Lightroom closed or crashed —
 * the server stops. Separately, when no page has been open for the idle window
 * and nothing is running, it stops too.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { JobRequest, RatingProfile } from '@shoots/app';
import { JobError, type JobRunner } from './jobs.js';
import { browse, type Library } from './library.js';
import { startIdleWatch, type IdleWatch } from './lifecycle.js';
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
}

const MAX_BODY = 16 * 1024;

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
      case 'GET /api/browse':
        return withUserError(res, () => browse(url.searchParams.get('path')));
      case 'GET /api/library': {
        const folder = url.searchParams.get('folder');
        if (!folder) return sendJson(res, 400, { error: 'Choose a folder.' });
        return withUserError(res, () => opts.library.list(folder, url.searchParams.get('recursive') === '1'));
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
      sendJson(res, 202, opts.jobs.start(request, photos));
    } catch (err) {
      sendJson(res, err instanceof JobError ? err.status : 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    server,
    stop,
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
