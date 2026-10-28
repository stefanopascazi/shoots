/**
 * The app server end to end over real HTTP, with the job runner and library
 * stubbed: the gate (Host, Origin, token), the launch handshake, and the two
 * ways it stops on its own.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobRunner } from '../../src/app/jobs.js';
import { Library } from '../../src/app/library.js';
import { clearSession, readSession, startIdleWatch, writeSession } from '../../src/app/lifecycle.js';
import { createAppServer, parseJobRequest, type AppServer, type StopReason } from '../../src/app/server.js';

const TOKEN = 'test-token-0123456789';
let running: AppServer | undefined;

async function start(overrides: { hostLeaseMs?: number; pageIdleMs?: number } = {}) {
  const stops: StopReason[] = [];
  const app = createAppServer({
    html: '<!doctype html><p>app</p>',
    token: TOKEN,
    info: { version: '9.9.9', platform: 'test', home: '/h' },
    library: new Library(),
    jobs: new JobRunner(),
    profiles: async () => [{ name: 'street', learned: false }],
    hostLeaseMs: overrides.hostLeaseMs ?? 60_000,
    pageIdleMs: overrides.pageIdleMs ?? 60_000,
    onStop: (r) => stops.push(r),
  });
  const port = await app.listen(0);
  running = app;
  return { port, stops, base: `http://127.0.0.1:${port}` };
}

afterEach(() => {
  running?.stop('shutdown');
  running = undefined;
});

const auth = { 'x-shoots-token': TOKEN };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('app server gate', () => {
  test('API calls need the token', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/info`)).status).toBe(401);
    const ok = await fetch(`${base}/api/info`, { headers: auth });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ version: '9.9.9', platform: 'test', home: '/h' });
  });

  test('a foreign Origin is refused even with the token', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/info`, { headers: { ...auth, origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
  });

  test('the page itself needs the session', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/`)).status).toBe(401);
  });

  test('the launch URL trades the token for a cookie and drops it from the address', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/?t=${TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const page = await fetch(`${base}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('<p>app</p>');
  });

  test('a wrong launch token is refused', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/?t=nope`, { redirect: 'manual' })).status).toBe(401);
  });

  test('thumbnails outside a listed folder are not served', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/thumb?path=${encodeURIComponent(path.join(tmpdir(), 'x.jpg'))}`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe('app server lifetime', () => {
  test('stops when the plug-in lease lapses', async () => {
    const { stops } = await start({ hostLeaseMs: 60 });
    await wait(200);
    expect(stops).toEqual(['host-lease']);
  });

  test('a renewed lease keeps it running', async () => {
    const { base, stops } = await start({ hostLeaseMs: 150 });
    for (let i = 0; i < 4; i++) {
      await wait(60);
      await fetch(`${base}/api/host/heartbeat`, { method: 'POST', headers: auth });
    }
    expect(stops).toEqual([]);
  });

  test('stops when no page checks in', async () => {
    const { stops } = await start({ pageIdleMs: 60 });
    await wait(200);
    expect(stops).toEqual(['idle']);
  });

  test('shutdown on request', async () => {
    const { base, stops } = await start();
    expect((await fetch(`${base}/api/shutdown`, { method: 'POST', headers: auth })).status).toBe(200);
    await wait(30);
    expect(stops).toEqual(['shutdown']);
  });
});

describe('parseJobRequest', () => {
  test('accepts known jobs and sanitises the profile', () => {
    expect(parseJobRequest('{"kind":"rate","folder":"/p","profile":"my-eye"}')).toEqual({
      kind: 'rate',
      folder: '/p',
      recursive: false,
      profile: 'my-eye',
    });
    expect(parseJobRequest('{"kind":"rate","folder":"/p","profile":"--evil x"}')?.profile).toBeUndefined();
  });

  test('rejects unknown kinds, photo jobs without a folder, and bad JSON', () => {
    expect(parseJobRequest('{"kind":"rm"}')).toBeUndefined();
    expect(parseJobRequest('{"kind":"cull"}')).toBeUndefined();
    expect(parseJobRequest('nope')).toBeUndefined();
  });
});

describe('lifecycle helpers', () => {
  test('a busy server never goes idle', async () => {
    let idle = false;
    const w = startIdleWatch(30, () => true, () => (idle = true), Date.now, 5);
    await wait(100);
    w.stop();
    expect(idle).toBe(false);
  });

  test('the session file is removed only by the process it describes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shoots-session-'));
    const file = path.join(dir, 'app.json');
    writeSession({ pid: 42, port: 1, token: 't', url: 'u', startedAt: 's' }, file);
    expect(readSession(file)?.port).toBe(1);
    clearSession(7, file);
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(42);
    clearSession(42, file);
    expect(readSession(file)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
