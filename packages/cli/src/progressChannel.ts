/**
 * Machine-readable progress for a host that runs the CLI as a child process,
 * such as the Lightroom plug-in. When SHOOTS_PROGRESS_FILE names a file, every
 * progress event is appended to it as one JSON line; otherwise this is a no-op.
 *
 * A file rather than stderr because the host cannot read a pipe while the
 * process runs (Lightroom's LrTasks.execute only returns at exit), but it can
 * poll a file. Writing never fails a run: progress is advisory.
 */
import { appendFileSync } from 'node:fs';

export type ProgressEvent =
  /** `url`: a page the host should offer, such as the calibration review. */
  | { kind: 'phase'; label: string; detail?: string; url?: string }
  | { kind: 'steps'; label: string; done: number; total: number; detail?: string }
  | { kind: 'download'; label: string; received: number; total: number | null };

/** A line of the progress file: an event, or the exit marker written once at the end. */
export type ProgressLine = ProgressEvent | { kind: 'exit'; code: number };

export const PROGRESS_FILE_ENV = 'SHOOTS_PROGRESS_FILE';

/** Minimum gap between two phase updates: a scan reports per file. */
const PHASE_MS = 200;

export interface ProgressChannel {
  emit: (event: ProgressEvent) => void;
}

/**
 * A channel over `file`, throttled so a host polling it sees every percent and
 * every phase change without the CLI writing a line per tick.
 */
export function createProgressChannel(file: string | undefined, now: () => number = Date.now): ProgressChannel {
  if (!file) return { emit: () => {} };
  let lastKey = '';
  let lastPhaseAt = 0;
  return {
    emit: (event) => {
      let key: string;
      if (event.kind === 'phase') {
        const t = now();
        key = `phase:${event.label}:${event.detail ?? ''}`;
        // A new label always goes out; a new detail on the same label waits its turn.
        if (lastKey.startsWith(`phase:${event.label}:`) && t - lastPhaseAt < PHASE_MS) return;
        lastPhaseAt = t;
      } else {
        const total = event.kind === 'steps' ? event.total : event.total ?? 0;
        const done = event.kind === 'steps' ? event.done : event.received;
        const pct = total > 0 ? Math.floor((done / total) * 100) : -1;
        key = `${event.kind}:${event.label}:${pct}`;
      }
      if (key === lastKey) return;
      lastKey = key;
      try {
        appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
      } catch {
        // Advisory only.
      }
    },
  };
}

let shared: ProgressChannel | undefined;

/** Emit on the process-wide channel named by SHOOTS_PROGRESS_FILE. */
export function emitProgress(event: ProgressEvent): void {
  shared ??= createProgressChannel(process.env[PROGRESS_FILE_ENV]);
  shared.emit(event);
}

/**
 * Append `{ kind: 'exit', code }` to the progress file when the process ends.
 *
 * A host that outlives its own restart — the app server re-adopting a training
 * run after Lightroom closed it — cannot wait on the child, so this line is how
 * it learns the run finished, rather than guessing from a process id.
 */
export function markExitOnProgressFile(file: string | undefined = process.env[PROGRESS_FILE_ENV]): void {
  if (!file) return;
  process.once('exit', (code) => {
    try {
      appendFileSync(file, JSON.stringify({ kind: 'exit', code: code ?? 0 }) + '\n', 'utf8');
    } catch {
      // Advisory only.
    }
  });
}
