/**
 * Progress plumbing between JobQueue callbacks and the Ink ProgressView.
 * Falls back to plain stderr logging when stdout is not a TTY or --json is on
 * (Ink rendering would corrupt piped output).
 */
import { EventEmitter } from 'node:events';
import type { JobProgress } from '@shoots/core';
import type { CliIo } from './io.js';

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
