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
