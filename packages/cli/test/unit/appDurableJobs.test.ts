import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CATALOG_WAIT_MS, DurableJobs, durableArgs, type DetachedChild, type Processes } from '../../src/app/durableJobs.js';
import { JobError } from '../../src/app/jobs.js';

const CATALOG = JSON.stringify({ version: 1, folder: 'F', photos: [] });

class FakeChild extends EventEmitter implements DetachedChild {
  constructor(readonly pid: number) {
    super();
  }
  unref() {}
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A runner over a temp folder, with processes that live until `ended` names them. */
function setup(root = mkdtempSync(path.join(tmpdir(), 'shoots-durable-'))) {
  if (!roots.includes(root)) roots.push(root);
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }> = [];
  const ended = new Set<number>();
  const killed: number[] = [];
  const processes: Processes = {
    alive: (pid) => !ended.has(pid),
    kill: (pid) => {
      killed.push(pid);
      ended.add(pid);
    },
  };
  let nextPid = 100;
  let clock = 1_000;
  const make = () =>
    new DurableJobs(root, {
      spawner: (_cmd, args, env) => {
        const child = new FakeChild(nextPid++);
        spawned.push({ args, env, child });
        return child;
      },
      processes,
      now: () => clock++,
    });
  const jobs = make();
  /** What the CLI leaves behind when it ends. */
  const end = (i: number, stdout: string, code: number, stderr = '') => {
    const { env, child } = spawned[i];
    const dir = path.dirname(env.SHOOTS_PROGRESS_FILE!);
    writeFileSync(path.join(dir, 'stdout.json'), stdout);
    writeFileSync(path.join(dir, 'stderr.log'), stderr);
    appendFileSync(env.SHOOTS_PROGRESS_FILE!, JSON.stringify({ kind: 'exit', code }) + '\n');
    ended.add(child.pid);
    child.emit('exit', code);
  };
  return { root, jobs, spawned, ended, killed, end, make };
}

describe('durableArgs', () => {
  test('training reads the catalog export with the confirmed settings', () => {
    expect(durableArgs({ kind: 'train', folder: 'C:\\Shoot' }, 'cat.json')).toEqual([
      'develop', 'init', 'C:\\Shoot', '--catalog', 'cat.json', '--boldness', '1', '--anchor-gain', '2', '--json',
    ]);
  });

  test('calibration opens the review with a deadline', () => {
    expect(durableArgs({ kind: 'calibrate' }, undefined)).toEqual(['develop', 'calibrate', '--review', '--review-timeout', '60', '--json']);
  });

  test('photo jobs are not durable', () => {
    expect(() => durableArgs({ kind: 'cull', folder: 'x' }, undefined)).toThrow(JobError);
  });
});

describe('DurableJobs', () => {
  test('training waits for Lightroom, then runs on the export', async () => {
    const { jobs, spawned } = setup();
    const job = jobs.start({ kind: 'train', folder: 'F', recursive: true });
    expect(job).toMatchObject({ kind: 'train', state: 'running', progress: { label: 'Reading your edits from Lightroom' } });
    expect(spawned).toHaveLength(0);
    expect(jobs.awaitingCatalog()).toEqual({ job: job.id, folder: 'F', recursive: true, raw: false });
    expect(jobs.busy).toBe(true);

    await jobs.provideCatalog(job.id, CATALOG);
    expect(spawned).toHaveLength(1);
    expect(jobs.awaitingCatalog()).toBeUndefined();
    const catalogFile = spawned[0].args[spawned[0].args.indexOf('--catalog') + 1];
    expect(existsSync(catalogFile)).toBe(true);
  });

  test('an export nobody waits for is refused', async () => {
    const { jobs } = setup();
    await expect(jobs.provideCatalog('job-nope', CATALOG)).rejects.toThrow(JobError);
  });

  test('the plug-in reading a folder shows as progress', () => {
    const { jobs } = setup();
    const job = jobs.start({ kind: 'catalog', folder: 'F' });
    jobs.catalogProgress(job.id, 50, 380);
    expect(jobs.get(job.id)!.progress).toEqual({ label: 'Reading your edits from Lightroom', done: 50, total: 380 });
  });

  test('a job the plug-in never answers fails instead of waiting for ever', () => {
    let clock = 0;
    const root = mkdtempSync(path.join(tmpdir(), 'shoots-durable-'));
    roots.push(root);
    const jobs = new DurableJobs(root, { processes: { alive: () => true, kill: () => {} }, now: () => clock });
    const job = jobs.start({ kind: 'catalog', folder: 'F' });
    clock = CATALOG_WAIT_MS - 1;
    jobs.catalogProgress(job.id, 0, 400);
    clock += CATALOG_WAIT_MS - 1;
    // Still within the window from the last sign of the plug-in.
    expect(jobs.get(job.id)!.state).toBe('running');
    clock += 2;
    expect(jobs.get(job.id)).toMatchObject({ state: 'failed' });
    expect(jobs.get(job.id)!.error).toContain('did not send');
    expect(jobs.busy).toBe(false);
  });

  test('a folder Lightroom does not have fails the job and names the folder', async () => {
    const { jobs, spawned } = setup();
    const job = jobs.start({ kind: 'train', folder: '\\\\NAS\\Photos' });
    const ended = await jobs.provideCatalog(job.id, JSON.stringify({ version: 1, folder: '\\\\NAS\\Photos', found: false, photos: [] }));
    expect(spawned).toHaveLength(0);
    expect(ended.state).toBe('failed');
    expect(ended.error).toContain('Lightroom has no folder \\\\NAS\\Photos');
  });

  test('the failure names the folders the catalog does have', async () => {
    const { jobs } = setup();
    const job = jobs.start({ kind: 'catalog', folder: 'Z:\\Photos' });
    const body = { version: 1, folder: 'Z:\\Photos', found: false, roots: ['\\\\NAS\\root'], photos: [] };
    expect((await jobs.provideCatalog(job.id, JSON.stringify(body))).error).toContain('start at: \\\\NAS\\root.');
  });

  test('export only keeps the file, reports how it reads, and starts nothing', async () => {
    const { root, jobs, spawned } = setup();
    const job = jobs.start({ kind: 'catalog', folder: 'F' });
    expect(jobs.awaitingCatalog()).toMatchObject({ job: job.id, raw: true });
    const text = JSON.stringify({
      version: 1,
      folder: 'F',
      photos: [{ path: '/F/a.cr3', settings: { Contrast2012: 12 }, raw: { Contrast2012: 12, ToneCurvePV2012: [0, 0, 255, 255] } }],
    });
    const done = await jobs.provideCatalog(job.id, text);
    expect(spawned).toHaveLength(0);
    expect(done).toMatchObject({ state: 'done', result: { photos: 1, edited: 1, raw: true, shapes: { ToneCurvePV2012: 'array of 4 numbers' } } });
    const kept = (done.result as { file: string }).file;
    expect(path.dirname(kept)).toBe(path.join(path.dirname(root), 'exports'));
    expect(readFileSync(kept, 'utf8')).toBe(text);
    rmSync(path.dirname(kept), { recursive: true, force: true });
    expect(jobs.busy).toBe(false);
  });

  test('a report on exit is done; the export is dropped', async () => {
    const { jobs, spawned, end } = setup();
    const job = jobs.start({ kind: 'train', folder: 'F' });
    await jobs.provideCatalog(job.id, CATALOG);
    appendFileSync(spawned[0].env.SHOOTS_PROGRESS_FILE!, JSON.stringify({ kind: 'steps', label: 'Fitting the profile', done: 2, total: 5 }) + '\n');
    expect(jobs.get(job.id)!.progress).toMatchObject({ label: 'Fitting the profile', done: 2, total: 5 });

    end(0, '{"command":"develop-init","profile":"p.json"}', 0);
    expect(jobs.get(job.id)).toMatchObject({ state: 'done', result: { command: 'develop-init', profile: 'p.json' } });
    expect(jobs.busy).toBe(false);
    const dir = path.dirname(spawned[0].env.SHOOTS_PROGRESS_FILE!);
    expect(existsSync(path.join(dir, 'catalog.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'status.json'))).toBe(true);
  });

  test('no report and a failing exit carry the last error', () => {
    const { jobs, end } = setup();
    const job = jobs.start({ kind: 'calibrate' });
    end(0, '', 2, 'error: no profile at x\n');
    expect(jobs.get(job.id)).toMatchObject({ state: 'failed', error: 'no profile at x' });
  });

  test('a clean exit without a report changed nothing, and is done', () => {
    const { jobs, end } = setup();
    const job = jobs.start({ kind: 'calibrate' });
    end(0, '', 0);
    expect(jobs.get(job.id)).toMatchObject({ state: 'done', result: undefined });
  });

  test('the review page reaches the status', () => {
    const { jobs, spawned } = setup();
    const job = jobs.start({ kind: 'calibrate' });
    appendFileSync(
      spawned[0].env.SHOOTS_PROGRESS_FILE!,
      JSON.stringify({ kind: 'phase', label: 'Waiting for your review', url: 'http://127.0.0.1:7391/' }) + '\n',
    );
    expect(jobs.get(job.id)!.progress).toEqual({ label: 'Waiting for your review', detail: undefined, url: 'http://127.0.0.1:7391/' });
  });

  test('a process gone without its exit line was killed', () => {
    const { jobs, spawned, ended } = setup();
    const job = jobs.start({ kind: 'calibrate' });
    ended.add(spawned[0].child.pid);
    expect(jobs.get(job.id)).toMatchObject({ state: 'failed', error: 'The job stopped unexpectedly.' });
  });

  test('one at a time', () => {
    const { jobs } = setup();
    jobs.start({ kind: 'calibrate' });
    expect(() => jobs.start({ kind: 'train', folder: 'F' })).toThrow('still running');
  });

  test('cancel stops the process', () => {
    const { jobs, spawned, killed } = setup();
    const job = jobs.start({ kind: 'calibrate' });
    expect(jobs.cancel(job.id)!.state).toBe('cancelled');
    expect(killed).toEqual([spawned[0].child.pid]);
    expect(jobs.busy).toBe(false);
  });

  test('on shutdown a waiting training fails, a running one carries on', () => {
    const { jobs } = setup();
    const waiting = jobs.start({ kind: 'train', folder: 'F' });
    jobs.release();
    expect(jobs.get(waiting.id)).toMatchObject({ state: 'failed' });

    const running = jobs.start({ kind: 'calibrate' });
    jobs.release();
    expect(jobs.get(running.id)!.state).toBe('running');
  });

  test('a later server picks up a run still going, and one that finished meanwhile', async () => {
    const first = setup();
    const job = first.jobs.start({ kind: 'train', folder: 'F' });
    await first.jobs.provideCatalog(job.id, CATALOG);

    // The server is gone; the run goes on.
    const second = first.make();
    expect(second.latest()).toMatchObject({ id: job.id, state: 'running' });
    expect(second.busy).toBe(true);

    first.end(0, '{"command":"develop-init"}', 0);
    const third = first.make();
    expect(third.latest()).toMatchObject({ id: job.id, state: 'done', result: { command: 'develop-init' } });
    expect(third.busy).toBe(false);
  });

  test('a training left waiting by a server that stopped is failed on recovery', () => {
    const first = setup();
    const job = first.jobs.start({ kind: 'train', folder: 'F' });
    const second = first.make();
    expect(second.get(job.id)).toMatchObject({ state: 'failed' });
    expect(second.busy).toBe(false);
  });

  test('only the last ten finished jobs keep their folder', () => {
    const { jobs, root, end } = setup();
    for (let i = 0; i < 12; i++) {
      jobs.start({ kind: 'calibrate' });
      end(i, '', 0);
    }
    expect(readdirSync(root)).toHaveLength(10);
  });
});
