/**
 * Training and calibration: jobs that outlive the app server.
 *
 * The server stops when Lightroom closes (the lease lapses), and a training run
 * takes hours. So these jobs run detached, with everything they say written to
 * files in their own folder under ~/.shoots/app/jobs/<id>: the request, the pid,
 * stdout (the --json report), stderr and the progress file. A server started
 * later reads that folder back and picks the job up where it is — still running,
 * or finished while nobody was watching.
 *
 * The CLI ends its progress file with `{ kind: 'exit' }` (markLifetimeOnProgressFile),
 * which is how a run is known to have finished without waiting on the process.
 * A pid that is gone with no such line means the run was killed.
 *
 * Training needs Lightroom once, at the start: the plug-in exports the folder's
 * develop settings from the catalog (the app cannot read the catalog). Until it
 * has, the job waits; after that it needs nothing from Lightroom or the server.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { CatalogRequest, JobKind, JobRequest, JobStatus } from '@shoots/app';
import { PROGRESS_FILE_ENV } from '../progressChannel.js';
import { selfInvocation } from '../selfInvoke.js';
import { JobError, lastErrorLine, parseJson } from './jobs.js';
import { exitCode, lastProgress } from './progress.js';
import { inspectCatalogExport } from '../develop/adapters/lightroom/inspect.js';
import { parseCatalogExport } from '../develop/adapters/lightroom/catalog.js';
import { shootWorkDir } from '../develop/shoot.js';

export const DURABLE_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['train', 'calibrate', 'catalog', 'refine']);
/** Jobs that start by waiting for the plug-in's catalog export. */
const NEEDS_CATALOG: ReadonlySet<JobKind> = new Set<JobKind>(['train', 'catalog', 'refine']);

/** The settings the owner confirmed by eye on real shoots (see the develop README). */
export const TRAIN_BOLDNESS = '1';
export const TRAIN_ANCHOR_GAIN = '2';
/** How long the calibration page waits before keeping the fitted values. */
export const REVIEW_TIMEOUT_MINUTES = '60';

/** How many finished jobs keep their folder. */
const KEEP_FINISHED = 10;

const WAITING_LABEL = 'Reading your edits from Lightroom';
/**
 * How long a job waits for the plug-in without a sign of it. The plug-in reports
 * progress while it reads, so only a plug-in that never started (or failed) runs
 * this out — instead of the job waiting for ever.
 */
export const CATALOG_WAIT_MS = 3 * 60_000;

/** CLI arguments for a durable job; `catalogFile` is the plug-in's export (training only). */
export function durableArgs(request: JobRequest, catalogFile: string | undefined): string[] {
  switch (request.kind) {
    case 'train':
      return [
        'develop',
        'init',
        request.folder!,
        '--catalog',
        catalogFile!,
        '--boldness',
        TRAIN_BOLDNESS,
        '--anchor-gain',
        TRAIN_ANCHOR_GAIN,
        '--json',
      ];
    case 'calibrate':
      return ['develop', 'calibrate', '--review', '--review-timeout', REVIEW_TIMEOUT_MINUTES, '--json'];
    case 'refine':
      // The refit keeps the settings the profile was trained with.
      return [
        'develop',
        'refine',
        request.folder!,
        '--catalog',
        catalogFile!,
        '--boldness',
        TRAIN_BOLDNESS,
        '--anchor-gain',
        TRAIN_ANCHOR_GAIN,
        '--json',
      ];
    default:
      throw new JobError('Not a training job.', 400);
  }
}

/** What job.json holds: enough to rebuild the job's status from its folder alone. */
export interface JobRecord {
  id: string;
  kind: JobKind;
  request: JobRequest;
  createdAt: number;
  /** waiting: training for the catalog export; running: the process is started. */
  phase: 'waiting' | 'running';
  pid?: number;
  startedAt?: number;
}

export interface DetachedChild {
  pid?: number;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
  unref(): void;
}

export interface DetachedSpawner {
  (command: string, args: string[], env: NodeJS.ProcessEnv, stdout: number, stderr: number): DetachedChild;
}

export interface Processes {
  alive(pid: number): boolean;
  /** Stops the process and whatever it started. */
  kill(pid: number): void;
}

const defaultSpawn: DetachedSpawner = (command, args, env, stdout, stderr) =>
  // Detached and given files instead of pipes: nothing ties the run to this server.
  spawn(command, args, { env, detached: true, stdio: ['ignore', stdout, stderr], windowsHide: true });

export const systemProcesses: Processes = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: it exists, it is just not ours to signal.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  kill(pid) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      // Detached on POSIX means its own process group: signal all of it.
      else process.kill(-pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  },
};

export interface DurableJobsOptions {
  /** Where export-only runs keep the catalog export; default: `exports` next to the jobs folder. */
  exportsDir?: string;
  spawner?: DetachedSpawner;
  processes?: Processes;
  now?: () => number;
}

const FILES = {
  record: 'job.json',
  status: 'status.json',
  progress: 'progress.jsonl',
  stdout: 'stdout.json',
  stderr: 'stderr.log',
  catalog: 'catalog.json',
} as const;

export class DurableJobs {
  private readonly active = new Map<string, JobRecord>();
  private readonly finished = new Map<string, JobStatus>();
  private readonly spawner: DetachedSpawner;
  private readonly processes: Processes;
  private readonly now: () => number;
  private readonly exportsDir: string;
  /** The plug-in's progress on each waiting job, and when it last gave a sign. */
  private readonly reading = new Map<string, { done: number; total: number; at: number }>();

  constructor(
    private readonly root: string,
    options: DurableJobsOptions = {},
  ) {
    this.spawner = options.spawner ?? defaultSpawn;
    this.processes = options.processes ?? systemProcesses;
    this.now = options.now ?? Date.now;
    this.exportsDir = options.exportsDir ?? path.join(path.dirname(root), 'exports');
    this.recover();
  }

  /** Something is waiting for Lightroom or still running. */
  get busy(): boolean {
    for (const id of [...this.active.keys()]) this.refresh(id);
    return this.active.size > 0;
  }

  start(request: JobRequest): JobStatus {
    if (!DURABLE_KINDS.has(request.kind)) throw new JobError('Not a training job.', 400);
    if (this.busy) throw new JobError('Another job is still running.', 409);
    if (NEEDS_CATALOG.has(request.kind) && !request.folder) throw new JobError('Choose a folder.', 400);
    if (request.kind === 'refine') {
      if (!existsSync(path.join(shootWorkDir(request.folder!), 'prediction.json'))) {
        throw new JobError('Nothing in this folder was developed with shoots yet: use Develop Selection in Lightroom first.', 400);
      }
      // What was developed may sit in subfolders of the one chosen: read them all back.
      request = { ...request, recursive: true };
    }

    const record: JobRecord = {
      id: `job-${this.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      kind: request.kind,
      request,
      createdAt: this.now(),
      phase: 'waiting',
    };
    mkdirSync(this.dir(record.id), { recursive: true });
    this.active.set(record.id, record);
    if (NEEDS_CATALOG.has(request.kind)) this.save(record);
    else this.launch(record, undefined);
    return this.get(record.id)!;
  }

  /** The training waiting for its catalog export, for the plug-in to pick up. */
  awaitingCatalog(): CatalogRequest | undefined {
    for (const r of this.active.values()) {
      if (NEEDS_CATALOG.has(r.kind) && r.phase === 'waiting') {
        return { job: r.id, folder: r.request.folder!, recursive: r.request.recursive === true, raw: r.kind === 'catalog' };
      }
    }
    return undefined;
  }

  /**
   * The plug-in's export for a waiting job. Training stores it next to the job
   * and starts the run; an export-only job keeps it under exports/ and reports
   * how it reads.
   */
  async provideCatalog(id: string, text: string): Promise<JobStatus> {
    const record = this.active.get(id);
    if (!record || !NEEDS_CATALOG.has(record.kind) || record.phase !== 'waiting') throw new JobError('No job is waiting for that export.', 409);
    const data = parseCatalogExport(text);
    if (!data.found) {
      this.finish(record, {
        state: 'failed',
        error:
          `Lightroom has no folder ${data.folder}. Choose it as Lightroom shows it in the Folders panel: ` +
          'a network share is \\\\NAS\\share, not the drive letter it may also be mapped to, or the other way round.' +
          (data.roots.length > 0 ? ` Its catalog folders start at: ${data.roots.join(', ')}.` : ''),
      });
      return this.get(id)!;
    }
    if (record.kind === 'catalog') {
      mkdirSync(this.exportsDir, { recursive: true });
      const kept = path.join(this.exportsDir, `catalog-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(kept, text, 'utf8');
      try {
        this.finish(record, { state: 'done', result: await inspectCatalogExport(text, kept) });
      } catch (e) {
        this.finish(record, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
      return this.get(id)!;
    }
    const file = path.join(this.dir(id), FILES.catalog);
    writeFileSync(file, text, 'utf8');
    this.launch(record, file);
    return this.get(id)!;
  }

  get(id: string): JobStatus | undefined {
    if (this.active.has(id)) this.refresh(id);
    const record = this.active.get(id);
    if (!record) return this.finished.get(id);
    return {
      id,
      kind: record.kind,
      state: 'running',
      startedAt: record.startedAt ?? record.createdAt,
      progress: record.phase === 'waiting' ? this.waitingProgress(id) : lastProgress(this.read(id, FILES.progress)),
    };
  }

  /** The running job, else the one that ended last: what the training screen shows. */
  latest(): JobStatus | undefined {
    for (const id of this.active.keys()) {
      const status = this.get(id);
      if (status) return status;
    }
    let last: JobStatus | undefined;
    for (const s of this.finished.values()) if (!last || (s.endedAt ?? 0) > (last.endedAt ?? 0)) last = s;
    return last;
  }

  cancel(id: string): JobStatus | undefined {
    const record = this.active.get(id);
    if (!record) return this.finished.get(id);
    if (record.pid !== undefined) this.processes.kill(record.pid);
    this.finish(record, { state: 'cancelled' });
    return this.finished.get(id);
  }

  /**
   * On shutdown. A training still waiting for Lightroom cannot get its export any
   * more; a running one carries on without us.
   */
  release(): void {
    for (const r of [...this.active.values()]) {
      if (r.phase === 'waiting') this.finish(r, { state: 'failed', error: 'Lightroom closed before your edits were read. Start it again.' });
    }
  }

  /** The plug-in reading a folder for a waiting job: a sign of life, and how far it got. */
  catalogProgress(id: string, done: number, total: number): void {
    if (this.active.get(id)?.phase !== 'waiting') return;
    this.reading.set(id, { done, total, at: this.now() });
  }

  private waitingProgress(id: string): JobStatus['progress'] {
    const r = this.reading.get(id);
    return r ? { label: WAITING_LABEL, done: r.done, total: r.total } : { label: WAITING_LABEL };
  }

  /** Folders of the jobs that ended: the history a clean-up may drop. */
  finishedFolders(): string[] {
    return [...this.finished.keys()].map((id) => this.dir(id));
  }

  /** Forgets every job that ended, folder and all. Running ones are untouched. */
  forgetFinished(): void {
    for (const id of this.finished.keys()) rmSync(this.dir(id), { recursive: true, force: true });
    this.finished.clear();
  }

  /** Where export-only runs keep the catalog exports. */
  get exportsFolder(): string {
    return this.exportsDir;
  }

  private launch(record: JobRecord, catalogFile: string | undefined): void {
    const dir = this.dir(record.id);
    const { command, args } = selfInvocation(durableArgs(record.request, catalogFile));
    const out = openSync(path.join(dir, FILES.stdout), 'w');
    const err = openSync(path.join(dir, FILES.stderr), 'w');
    let child: DetachedChild;
    try {
      child = this.spawner(command, args, { ...process.env, [PROGRESS_FILE_ENV]: path.join(dir, FILES.progress) }, out, err);
    } catch (e) {
      this.finish(record, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
      return;
    } finally {
      closeSync(out);
      closeSync(err);
    }
    record.phase = 'running';
    record.pid = child.pid;
    record.startedAt = this.now();
    this.save(record);
    // While this server lives it hears the end at once; a later one reads the files.
    child.once('exit', () => this.refresh(record.id));
    child.once('error', (e) => {
      if (this.active.has(record.id)) this.finish(record, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
    });
    child.unref();
  }

  /** Settles a running job whose process has ended. */
  private refresh(id: string): void {
    const record = this.active.get(id);
    if (!record) return;
    if (record.phase === 'waiting') {
      const lastSign = this.reading.get(id)?.at ?? record.createdAt;
      if (this.now() - lastSign > CATALOG_WAIT_MS) {
        this.finish(record, {
          state: 'failed',
          error:
            'Lightroom did not send the folder’s settings. Check that the plug-in is up to date; ' +
            'its log is Documents\\LrClassicLogs\\shoots.log.',
        });
      }
      return;
    }
    const code = exitCode(this.read(id, FILES.progress));
    if (code === undefined && record.pid !== undefined && this.processes.alive(record.pid)) return;

    const result = parseJson(this.read(id, FILES.stdout));
    // A report means the command got to the end, even with failures inside it;
    // a clean exit without one (calibration left unsaved) changed nothing.
    if (result !== undefined || code === 0) return this.finish(record, { state: 'done', result });
    const error = lastErrorLine(this.read(id, FILES.stderr));
    this.finish(record, {
      state: 'failed',
      error: error ?? (code === undefined ? 'The job stopped unexpectedly.' : `The job exited with code ${code}.`),
    });
  }

  private finish(record: JobRecord, outcome: Pick<JobStatus, 'state' | 'result' | 'error'>): void {
    if (!this.active.has(record.id)) return;
    const status: JobStatus = {
      id: record.id,
      kind: record.kind,
      startedAt: record.startedAt ?? record.createdAt,
      progress: record.phase === 'running' ? lastProgress(this.read(record.id, FILES.progress)) : undefined,
      ...outcome,
      endedAt: this.now(),
    };
    this.active.delete(record.id);
    this.finished.set(record.id, status);
    try {
      writeFileSync(path.join(this.dir(record.id), FILES.status), JSON.stringify(status) + '\n', 'utf8');
      // The export can be large and is only needed to start the run.
      rmSync(path.join(this.dir(record.id), FILES.catalog), { force: true });
    } catch {
      // The status stays in memory for this session.
    }
    this.prune();
  }

  /** Reads every job folder back: finished ones as they ended, the rest as live jobs. */
  private recover(): void {
    let ids: string[];
    try {
      ids = readdirSync(this.root);
    } catch {
      return;
    }
    for (const id of ids) {
      const status = readJson<JobStatus>(path.join(this.dir(id), FILES.status));
      if (status) {
        this.finished.set(id, status);
        continue;
      }
      const record = readJson<JobRecord>(path.join(this.dir(id), FILES.record));
      if (!record || record.id !== id) continue;
      this.active.set(id, record);
      // The server that asked Lightroom for the export is gone, and the request with it.
      if (record.phase === 'waiting') this.finish(record, { state: 'failed', error: 'Lightroom closed before your edits were read. Start it again.' });
      else this.refresh(id);
    }
    this.prune();
  }

  private prune(): void {
    const done = [...this.finished.values()].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const s of done.slice(KEEP_FINISHED)) {
      this.finished.delete(s.id);
      rmSync(this.dir(s.id), { recursive: true, force: true });
    }
  }

  private save(record: JobRecord): void {
    writeFileSync(path.join(this.dir(record.id), FILES.record), JSON.stringify(record) + '\n', 'utf8');
  }

  private read(id: string, file: string): string {
    try {
      return readFileSync(path.join(this.dir(id), file), 'utf8');
    } catch {
      return '';
    }
  }

  private dir(id: string): string {
    return path.join(this.root, id);
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return existsSync(file) && statSync(file).isFile() ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
  } catch {
    return undefined;
  }
}
