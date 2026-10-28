/**
 * Long work runs as a child process of this same build, exactly as the plug-in
 * runs it: `--json` for the result, SHOOTS_PROGRESS_FILE for progress. The app
 * therefore exercises the very commands the plug-in calls, and a crash in a
 * model never takes the server down.
 *
 * Analysis only: every job is a --dry-run. The app never writes next to the
 * photographs; results go back to Lightroom through the plug-in.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JobKind, JobRequest, JobStatus } from '@shoots/app';
import { PROGRESS_FILE_ENV } from '../progressChannel.js';
import { selfInvocation } from '../selfInvoke.js';
import { lastProgress } from './progress.js';

export class JobError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** CLI arguments for a job; `listFile` holds the photos to work on, one per line. */
export function jobArgs(request: JobRequest, listFile: string | undefined): string[] {
  switch (request.kind) {
    case 'doctor':
      return ['doctor', '--json'];
    case 'cull':
      return ['cull', '--files-from', listFile!, '--dry-run', '--json'];
    case 'rate':
      return [
        'rate',
        '--files-from',
        listFile!,
        '--dry-run',
        '--json',
        ...(request.profile ? ['--profile', request.profile] : []),
      ];
  }
}

const NEEDS_PHOTOS: ReadonlySet<JobKind> = new Set(['cull', 'rate']);

export interface Spawner {
  (command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess;
}

const defaultSpawn: Spawner = (command, args, env) =>
  spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

interface Running {
  status: JobStatus;
  child: ChildProcess;
  dir: string;
  progressFile: string;
}

/** One job at a time: the work is CPU- and disk-bound, two would only halve each other. */
export class JobRunner {
  private seq = 0;
  private current: Running | undefined;
  private readonly finished = new Map<string, JobStatus>();

  constructor(
    private readonly spawner: Spawner = defaultSpawn,
    /** Called once per job when it ends, whatever the outcome. */
    private readonly onFinish?: (status: JobStatus) => void,
  ) {}

  get busy(): boolean {
    return this.current !== undefined;
  }

  start(request: JobRequest, photos: readonly string[] = []): JobStatus {
    if (this.current) throw new JobError('Another job is still running.', 409);
    if (NEEDS_PHOTOS.has(request.kind) && photos.length === 0) throw new JobError('There are no photos to work on.', 400);

    const dir = mkdtempSync(path.join(tmpdir(), 'shoots-job-'));
    const progressFile = path.join(dir, 'progress.jsonl');
    let listFile: string | undefined;
    if (NEEDS_PHOTOS.has(request.kind)) {
      listFile = path.join(dir, 'files.txt');
      writeFileSync(listFile, photos.join('\n') + '\n', 'utf8');
    }

    const { command, args } = selfInvocation(jobArgs(request, listFile));
    const child = this.spawner(command, args, { ...process.env, [PROGRESS_FILE_ENV]: progressFile });
    const status: JobStatus = { id: `job-${++this.seq}`, kind: request.kind, state: 'running', startedAt: Date.now() };
    const running: Running = { status, child, dir, progressFile };
    this.current = running;

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => this.finish(running, 'failed', undefined, e.message));
    child.on('close', (code) => {
      if (status.state !== 'running') return;
      const stdout = Buffer.concat(out).toString('utf8');
      const result = parseJson(stdout);
      // Exit 1 with a report means "some files failed": still a result worth showing.
      if (result !== undefined) this.finish(running, 'done', result);
      else this.finish(running, 'failed', undefined, lastErrorLine(Buffer.concat(err).toString('utf8')) ?? `exited with code ${code}`);
    });
    return { ...status };
  }

  get(id: string): JobStatus | undefined {
    if (this.current?.status.id === id) return this.snapshot(this.current);
    return this.finished.get(id);
  }

  cancel(id: string): JobStatus | undefined {
    const running = this.current;
    if (!running || running.status.id !== id) return this.finished.get(id);
    this.finish(running, 'cancelled');
    running.child.kill();
    return this.finished.get(id);
  }

  /** Stops whatever runs; used on shutdown. */
  stopAll(): void {
    if (this.current) this.cancel(this.current.status.id);
  }

  private snapshot(running: Running): JobStatus {
    let progress = running.status.progress;
    try {
      progress = lastProgress(readFileSync(running.progressFile, 'utf8')) ?? progress;
    } catch {
      // Not written yet.
    }
    running.status.progress = progress;
    return { ...running.status };
  }

  private finish(running: Running, state: JobStatus['state'], result?: unknown, error?: string): void {
    if (running.status.state !== 'running') return;
    const final: JobStatus = { ...this.snapshot(running), state, result, error, endedAt: Date.now() };
    running.status.state = state;
    this.finished.set(final.id, final);
    if (this.current === running) this.current = undefined;
    rmSync(running.dir, { recursive: true, force: true });
    this.onFinish?.(final);
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** The last `error:` line a command printed, without the prefix. */
export function lastErrorLine(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).filter((l) => l.startsWith('error: '));
  return lines.at(-1)?.slice('error: '.length);
}
