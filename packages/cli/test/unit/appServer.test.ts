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
import { DurableJobs, type DetachedChild } from '../../src/app/durableJobs.js';
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

class FakeDetached extends EventEmitter implements DetachedChild {
  pid = 4242;
  unref() {}
}

const TOKEN = 'test-token-0123456789';
let running: AppServer | undefined;

async function start(overrides: { hostLeaseMs?: number; pageIdleMs?: number } = {}) {
  const stops: StopReason[] = [];
  const children: FakeChild[] = [];
  const detached: string[][] = [];
  const jobsRoot = mkdtempSync(path.join(tmpdir(), 'shoots-server-jobs-'));
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
    durable: new DurableJobs(jobsRoot, {
      spawner: (_cmd, args) => {
        detached.push(args);
        return new FakeDetached();
      },
      processes: { alive: () => true, kill: () => {} },
    }),
    store: await AppStore.open(':memory:'),
    developStatus: async () => ({
      command: 'develop-status',
      dataset: { path: 'd', exists: false, bytes: 0 },
      profile: { path: 'p', exists: false },
    }),
    profiles: async () => [{ name: 'street', learned: false }],
    hostLeaseMs: overrides.hostLeaseMs ?? 60_000,
    pageIdleMs: overrides.pageIdleMs ?? 60_000,
    onStop: (r) => stops.push(r),
  });
  const port = await app.listen(0);
  running = app;
  roots.push(jobsRoot);
  return { port, stops, children, detached, base: `http://127.0.0.1:${port}` };
}

const roots: string[] = [];
afterEach(() => {
  running?.stop('shutdown');
  running = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
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

  test('cull results and marks come back with the folder, and reset forgets them', async () => {
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

    const mark = (marks: unknown) => fetch(`${base}/api/marks`, { method: 'PUT', headers: auth, body: JSON.stringify({ marks }) }).then((r) => r.json());
    expect(await mark({ '/etc/x.jpg': { flag: 'pick' } })).toEqual({ marks: {} });
    expect(await mark({ [photo]: { flag: 'pick', stars: 9, label: 'red' } })).toEqual({ marks: { [photo]: { flag: 'pick', label: 'red' } } });

    const again = await list();
    expect(again.cull.map((c: { verdict: string }) => c.verdict)).toEqual(['blurry']);
    expect(again.marks).toEqual({ [photo]: { flag: 'pick', label: 'red' } });

    const reset = (parts: string[]) => fetch(`${base}/api/reset`, { method: 'POST', headers: auth, body: JSON.stringify({ folder: dir, parts }) }).then((r) => r.json());
    expect(await reset([])).toEqual({ error: 'Choose what to reset.' });
    expect(await reset(['cull'])).toEqual({ reset: 1 });
    const afterCull = await list();
    expect([afterCull.cull.length, Object.keys(afterCull.marks).length]).toEqual([0, 1]);

    expect((await fetch(`${base}/api/memory`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await (await fetch(`${base}/api/start`, { headers: auth })).json()).recent).toEqual([]);
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
    // Only the reject travels: a sharp verdict with no flag of yours leaves the pick in Lightroom alone.
    expect(await send()).toEqual({ queued: 1 });
    expect(await send()).toEqual({ queued: 0 });

    const beat = await (await fetch(`${base}/api/host/heartbeat`, { method: 'POST', headers: auth })).json();
    expect(beat.pending).toBe(1);
    const { items } = await (await fetch(`${base}/api/outbox`, { headers: auth })).json();
    expect(items).toEqual([{ id: items[0].id, path: blurry, rating: null, pick: -1, label: null }]);

    const ack = await fetch(`${base}/api/outbox/ack`, { method: 'POST', headers: auth, body: JSON.stringify({ applied: [items[0].id], missing: [] }) });
    expect(await ack.json()).toEqual({ settled: 1 });
    const state = await (await fetch(`${base}/api/outbox/state?folder=${encodeURIComponent(dir)}`, { headers: auth })).json();
    expect(state[blurry].state).toBe('applied');

    // Your pick changes what Lightroom should hold, so it travels again.
    await fetch(`${base}/api/marks`, { method: 'PUT', headers: auth, body: JSON.stringify({ marks: { [blurry]: { flag: 'pick' } } }) });
    expect(await send()).toEqual({ queued: 1 });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('following Lightroom', () => {
  test('the heartbeat names the open folder; a report becomes marks and bumps the revision', async () => {
    const { base } = await start();
    const dir = mkdtempSync(path.join(tmpdir(), 'shoots-follow-'));
    const photo = path.join(dir, 'a.jpg');
    writeFileSync(photo, 'x');

    const beat = () => fetch(`${base}/api/host/heartbeat`, { method: 'POST', headers: auth }).then((r) => r.json());
    expect((await beat()).watch).toBeNull();
    const listing = await (await fetch(`${base}/api/library?folder=${encodeURIComponent(dir)}`, { headers: auth })).json();
    expect((await beat()).watch).toEqual({ folder: listing.folder, recursive: false });

    const sync = () => fetch(`${base}/api/sync`, { headers: auth }).then((r) => r.json());
    expect(await sync()).toEqual({ revision: 0, following: false });

    const report = (photos: unknown[]) =>
      fetch(`${base}/api/lightroom/state`, { method: 'POST', headers: auth, body: JSON.stringify({ folder: listing.folder, photos }) }).then((r) => r.json());
    // A photo outside the folder and a malformed one are ignored.
    expect(await report([{ path: photo, rating: 4, pick: 1, label: 'red' }, { path: '/etc/x.jpg', rating: 1, pick: 0, label: 'none' }, { path: photo }])).toEqual({ changed: 1 });
    expect(await sync()).toEqual({ revision: 1, following: true });

    const again = await (await fetch(`${base}/api/library?folder=${encodeURIComponent(dir)}`, { headers: auth })).json();
    expect(again.marks[photo]).toEqual({ stars: 4, flag: 'pick', label: 'red' });
    expect(again.sent[photo].state).toBe('applied');

    // Nothing new, no new revision.
    expect(await report([{ path: photo, rating: 4, pick: 1, label: 'red' }])).toEqual({ changed: 0 });
    expect((await sync()).revision).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('training', () => {
  const post = (base: string, route: string, body: unknown) =>
    fetch(`${base}${route}`, { method: 'POST', headers: auth, body: typeof body === 'string' ? body : JSON.stringify(body) });

  test('the heartbeat asks for the catalog; the export starts the detached run', async () => {
    const { base, detached } = await start();
    const job = await (await post(base, '/api/jobs', { kind: 'train', folder: 'C:/Shoot', recursive: true })).json();
    expect(job).toMatchObject({ kind: 'train', state: 'running' });

    const beat = await (await post(base, '/api/host/heartbeat', {})).json();
    expect(beat.export).toEqual({ job: job.id, folder: 'C:/Shoot', recursive: true, raw: false });
    // Nothing else may start meanwhile.
    expect((await post(base, '/api/jobs', { kind: 'doctor' })).status).toBe(409);

    expect((await post(base, `/api/catalog/export?job=${job.id}`, 'not json')).status).toBe(400);
    const res = await post(base, `/api/catalog/export?job=${job.id}`, { version: 1, folder: 'C:/Shoot', photos: [] });
    expect(res.status).toBe(200);
    expect(detached).toHaveLength(1);
    expect(detached[0]).toContain('--catalog');
    expect((await (await post(base, '/api/host/heartbeat', {})).json()).export).toBeNull();

    const latest = await (await fetch(`${base}/api/jobs/training`, { headers: auth })).json();
    expect(latest.job).toMatchObject({ id: job.id, state: 'running' });
    expect((await (await fetch(`${base}/api/jobs/${job.id}`, { headers: auth })).json()).id).toBe(job.id);
  });

  test('an export for no waiting training is refused', async () => {
    const { base } = await start();
    expect((await post(base, '/api/catalog/export?job=job-x', { version: 1, folder: 'f', photos: [] })).status).toBe(409);
  });

  test('the develop profile status is served', async () => {
    const { base } = await start();
    const status = await (await fetch(`${base}/api/develop/status`, { headers: auth })).json();
    expect(status.profile.exists).toBe(false);
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
    expect(parseJobRequest('{"kind":"train","folder":"/p"}')).toMatchObject({ kind: 'train', folder: '/p' });
    expect(parseJobRequest('{"kind":"calibrate"}')).toMatchObject({ kind: 'calibrate' });
  });

  test('rejects unknown kinds, photo jobs without a folder, and bad JSON', () => {
    expect(parseJobRequest('{"kind":"rm"}')).toBeUndefined();
    expect(parseJobRequest('{"kind":"cull"}')).toBeUndefined();
    expect(parseJobRequest('{"kind":"train"}')).toBeUndefined();
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
