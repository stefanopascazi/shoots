/**
 * Progress plumbing between JobQueue callbacks and the Ink ProgressView.
 * Falls back to plain stderr logging when stdout is not a TTY or --json is on
 * (Ink rendering would corrupt piped output).
 */
import { EventEmitter } from 'node:events';
import type { JobProgress } from '@shoots/core';
import type { CliIo } from './io.js';

/** A long, indeterminate startup step (scanning, bulk metadata reads, model load). */
export interface PhaseHandle {
  /** Set the detail shown after the label. Cheap: the timer does the painting. */
  update: (detail: string) => void;
  /** Finish the phase, leaving one summary line behind. */
  done: (detail?: string) => void;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Report a phase that runs *before* per-file progress exists.
 *
 * Commands spend their first seconds — minutes, on a network catalog — walking
 * directories and batch-reading metadata, with nothing to count yet. Without a
 * heartbeat the CLI looks hung. Renders a spinner with elapsed time on a TTY,
 * falls back to plain verbose lines otherwise, and stays silent under --json so
 * stdout is never touched.
 */
export function startPhase(io: CliIo, label: string): PhaseHandle {
  const started = Date.now();
  const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  let detail = '';

  // Match startProgress: the Ink view keys off stdout being a TTY but draws on
  // stderr, so that stdout stays clean for the result.
  const interactive = process.stdout.isTTY === true && !io.json;
  if (!interactive) {
    if (io.verbose) process.stderr.write(`· ${label}…\n`);
    return {
      update: (d) => { detail = d; },
      done: (d) => {
        if (io.verbose) process.stderr.write(`· ${label} — ${d ?? detail ?? 'done'} (${elapsed()})\n`);
      },
    };
  }

  let frame = 0;
  const paint = (): void => {
    frame = (frame + 1) % SPINNER.length;
    process.stderr.write(`\r\x1b[2K${SPINNER[frame]} ${label}${detail ? ` ${detail}` : ''} — ${elapsed()}`);
  };
  paint();
  const timer = setInterval(paint, 80);
  // Never let the heartbeat hold the process open.
  timer.unref?.();

  return {
    update: (d) => { detail = d; },
    done: (d) => {
      clearInterval(timer);
      const final = d ?? detail;
      process.stderr.write(`\r\x1b[2K✓ ${label}${final ? ` — ${final}` : ''} (${elapsed()})\n`);
    },
  };
}

/** A determinate, synchronous progress bar over CPU-bound work. */
export interface StepsHandle {
  /** Cumulative progress, in whatever work units the caller counts in. */
  update: (done: number, total: number, detail?: string) => void;
  /** Finish, leaving one summary line behind. */
  done: (detail?: string) => void;
}

const BAR_WIDTH = 24;
/** Minimum gap between repaints — the caller can tick far faster than the eye. */
const PAINT_MS = 80;

const duration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

/**
 * Report work that blocks the event loop, and therefore cannot be spun.
 *
 * {@link startPhase} paints from a timer, which is exactly wrong for a fit: the
 * whole of `develop train` is one synchronous call, so a timer never gets to
 * fire and the CLI looks hung for as long as the maths takes (two and a half
 * minutes on a few hundred photographs). This is the other shape — the work
 * pushes its own progress out from inside the loop, and every paint is a plain
 * synchronous write.
 *
 * Off a TTY it degrades to one line per tenth, so the interactive shell (which
 * runs commands as a child with a piped stdout) still sees the fit advancing
 * rather than nothing at all. Silent under --json, like everything else here.
 */
export function startSteps(io: CliIo, label: string): StepsHandle {
  const started = Date.now();
  if (io.json) return { update: () => {}, done: () => {} };

  const interactive = process.stdout.isTTY === true;
  let lastPaint = 0;
  let lastTenth = -1;
  let painted = false;

  /** Elapsed, plus what is left at the rate measured so far. */
  const timing = (fraction: number): string => {
    const spent = Date.now() - started;
    if (fraction < 0.05 || fraction >= 1) return duration(spent);
    return `${duration(spent)}, ~${duration((spent * (1 - fraction)) / fraction)} left`;
  };

  return {
    update: (done, total, detail) => {
      if (total <= 0) return;
      const fraction = Math.min(1, Math.max(0, done / total));
      if (interactive) {
        const now = Date.now();
        if (now - lastPaint < PAINT_MS && fraction < 1) return;
        lastPaint = now;
        const filled = Math.round(fraction * BAR_WIDTH);
        const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
        process.stderr.write(
          `\r\x1b[2K${bar} ${String(Math.round(fraction * 100)).padStart(3)}%  ${label}` +
            `${detail ? ` · ${detail}` : ''} — ${timing(fraction)}`,
        );
        painted = true;
        return;
      }
      // Piped: one line per tenth. Not gated on --verbose — a fit that prints
      // nothing for minutes is the thing this exists to stop.
      const tenth = Math.floor(fraction * 10);
      if (tenth <= lastTenth) return;
      lastTenth = tenth;
      process.stderr.write(
        `· ${label} ${String(tenth * 10).padStart(3)}%${detail ? `  ${detail}` : ''} (${timing(fraction)})\n`,
      );
    },
    done: (detail) => {
      if (interactive && painted) process.stderr.write('\r\x1b[2K');
      process.stderr.write(`✓ ${label}${detail ? ` — ${detail}` : ''} (${duration(Date.now() - started)})\n`);
    },
  };
}

export class ProgressTracker extends EventEmitter {
  total: number;
  completed = 0;
  label = '';

  constructor(total: number) {
    super();
    this.total = total;
  }

  update(progress: JobProgress): void {
    this.completed = progress.completed;
    if (progress.label) this.label = progress.label;
    this.emit('progress', { ...progress });
  }
}

export interface ProgressHandle {
  tracker: ProgressTracker;
  onProgress: (p: JobProgress) => void;
  /** Unmount the Ink view (must be called before printing final output). */
  stop: () => void;
}

/**
 * Start batch progress reporting. Interactive Ink view when appropriate,
 * otherwise per-file stderr lines in verbose mode, otherwise silent.
 */
export async function startProgress(io: CliIo, total: number, title: string): Promise<ProgressHandle> {
  const tracker = new ProgressTracker(total);
  const interactive = process.stdout.isTTY === true && !io.json;

  if (interactive) {
    // Dynamic imports keep Ink/React out of the non-interactive path entirely.
    const [{ render }, React, { ProgressView }] = await Promise.all([
      import('ink'),
      import('react'),
      import('./components/ProgressView.js'),
    ]);
    const instance = render(React.createElement(ProgressView, { tracker, title }), {
      stdout: process.stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });
    return {
      tracker,
      onProgress: (p) => tracker.update(p),
      stop: () => {
        instance.unmount();
        instance.cleanup();
      },
    };
  }

  return {
    tracker,
    onProgress: (p) => {
      tracker.update(p);
      if (io.verbose) {
        process.stderr.write(`· [${p.completed}/${p.total}] ${p.label ?? ''}\n`);
      }
    },
    stop: () => {},
  };
}
