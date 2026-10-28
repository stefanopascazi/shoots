/**
 * The app server end to end over real HTTP, with the job runner and library
 * stubbed: the gate (Host, Origin, token), the launch handshake, and the two
 * ways it stops on its own.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobRunner } from '../../src/app/jobs.js';
import { Library } from '../../src/app/library.js';
import { clearSession, readSession, startIdleWatch, writeSession } from '../../src/app/lifecycle.js';
import { createAppServer, parseJobRequest, type AppServer, type StopReason } from '../../src/app/server.js';
import { AppStore } from '../../src/app/store.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() {
    return true;
  }
}

const TOKEN = 'test-token-0123456789';
let running: AppServer | undefined;

async function start(overrides: { hostLeaseMs?: number; pageIdleMs?: number } = {}) {
  const stops: StopReason[] = [];
  const children: FakeChild[] = [];
  let app: AppServer | undefined;
  const jobs = new JobRunner(
    () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    (status) => app?.jobFinished(status),
  );
  app = createAppServer({
    html: '<!doctype html><p>app</p>',
    token: TOKEN,
    info: { version: '9.9.9', platform: 'test', home: '/h' },
    library: new Library(),
    jobs,
    store: await AppStore.open(':memory:'),
    profiles: async () => [{ name: 'street', learned: false }],
    hostLeaseMs: overrides.hostLeaseMs ?? 60_000,
    pageIdleMs: overrides.pageIdleMs ?? 60_000,
    onStop: (r) => stops.push(r),
  });
  const port = await app.listen(0);
  running = app;
  return { port, stops, children, base: `http://127.0.0.1:${port}` };
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

describe('app server memory', () => {
  test('a folder named on the launch URL opens first, once', async () => {
    const { base } = await start();
    await fetch(`${base}/?t=${TOKEN}&folder=${encodeURIComponent('/shoot')}`, { redirect: 'manual' });
    const first = await (await fetch(`${base}/api/start`, { headers: auth })).json();
    expect(first.startFolder).toBe('/shoot');
    expect(first.settings.reopenLastFolder).toBe(true);
    const second = await (await fetch(`${base}/api/start`, { headers: auth })).json();
    expect(second.startFolder).toBeNull();
  });

  test('settings round-trip and bad values are ignored', async () => {
    const { base } = await start();
    const put = await fetch(`${base}/api/settings`, { method: 'PUT', headers: auth, body: JSON.stringify({ sort: 'rating', theme: 'sepia' }) });
    expect(await put.json()).toMatchObject({ sort: 'rating', theme: 'system' });
  });

  test('cull results and decisions come back with the folder', async () => {
    const { base, children } = await start();
    const dir = mkdtempSync(path.join(tmpdir(), 'shoots-app-'));
    const photo = path.join(dir, 'a.jpg');
    writeFileSync(photo, 'x');
    const list = () => fetch(`${base}/api/library?folder=${encodeURIComponent(dir)}`, { headers: auth }).then((r) => r.json());

    const first = await list();
    expect(first.cull).toEqual([]);
    expect((await (await fetch(`${base}/api/start`, { headers: auth })).json()).startFolder).toBe(first.folder);

    const job = await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: auth, body: JSON.stringify({ kind: 'cull', folder: dir }) })).json();
    children[0].stdout.emit('data', Buffer.from(JSON.stringify({ command: 'cull', results: [{ file: photo, score: 9, focusPeak: 9, verdict: 'blurry', rescued: false, aperture: null }] })));
    children[0].emit('close', 0);
    expect((await (await fetch(`${base}/api/jobs/${job.id}`, { headers: auth })).json()).state).toBe('done');

    const outside = await fetch(`${base}/api/decisions`, { method: 'PUT', headers: auth, body: JSON.stringify({ decisions: { '/etc/x.jpg': 'keep' } }) });
    expect(await outside.json()).toEqual({ saved: 0 });
    const inside = await fetch(`${base}/api/decisions`, { method: 'PUT', headers: auth, body: JSON.stringify({ decisions: { [photo]: 'keep' } }) });
    expect(await inside.json()).toEqual({ saved: 1 });

    const again = await list();
    expect(again.cull.map((c: { verdict: string }) => c.verdict)).toEqual(['blurry']);
    expect(again.decisions).toEqual({ [photo]: 'keep' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('send to Lightroom', () => {
  test('queues what the folder carries, the plug-in collects and settles it', async () => {
    const { base, children } = await start();
    const dir = mkdtempSync(path.join(tmpdir(), 'shoots-send-'));
    const blurry = path.join(dir, 'a.jpg');
    const sharp = path.join(dir, 'b.jpg');
    writeFileSync(blurry, 'x');
    writeFileSync(sharp, 'x');
    await fetch(`${base}/api/library?folder=${encodeURIComponent(dir)}`, { headers: auth });
    await fetch(`${base}/api/jobs`, { method: 'POST', headers: auth, body: JSON.stringify({ kind: 'cull', folder: dir }) });
    const item = (file: string, verdict: string) => ({ file, score: 1, focusPeak: 1, verdict, rescued: false, aperture: null });
    children[0].stdout.emit('data', Buffer.from(JSON.stringify({ command: 'cull', results: [item(blurry, 'blurry'), item(sharp, 'sharp')] })));
    children[0].emit('close', 0);

    const send = () => fetch(`${base}/api/outbox`, { method: 'POST', headers: auth, body: JSON.stringify({ folder: dir }) }).then((r) => r.json());
    // Only the reject travels: a sharp verdict with no decision leaves the pick in Lightroom alone.
    expect(await send()).toEqual({ queued: 1 });
    expect(await send()).toEqual({ queued: 0 });

    const beat = await (await fetch(`${base}/api/host/heartbeat`, { method: 'POST', headers: auth })).json();
    expect(beat.pending).toBe(1);
    const { items } = await (await fetch(`${base}/api/outbox`, { headers: auth })).json();
    expect(items).toEqual([{ id: items[0].id, path: blurry, rating: null, pick: -1 }]);

    const ack = await fetch(`${base}/api/outbox/ack`, { method: 'POST', headers: auth, body: JSON.stringify({ applied: [items[0].id], missing: [] }) });
    expect(await ack.json()).toEqual({ settled: 1 });
    const state = await (await fetch(`${base}/api/outbox/state?folder=${encodeURIComponent(dir)}`, { headers: auth })).json();
    expect(state[blurry].state).toBe('applied');

    // Your Keep changes what Lightroom should hold, so it travels again.
    await fetch(`${base}/api/decisions`, { method: 'PUT', headers: auth, body: JSON.stringify({ decisions: { [blurry]: 'keep' } }) });
    expect(await send()).toEqual({ queued: 1 });
    rmSync(dir, { recursive: true, force: true });
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
