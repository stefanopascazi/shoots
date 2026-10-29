/**
 * What the app server says in the console window it runs in.
 *
 * On Windows the plug-in starts the server with `start /B` from a console that
 * stays open as long as the server does. Its output goes to a log, so the window
 * was blank and looked closable. It now says what it is, and what closing it does.
 * Written to the console itself (CONOUT$), since stdout is redirected to the log.
 */
import { writeFileSync } from 'node:fs';
import type { JobKind } from '@shoots/app';

export const CONSOLE_TITLE = 'shoots — leave open while you use shoots';

export const BANNER = [
  '',
  '  shoots is running for Lightroom.',
  '  Leave this window open while you use the app: closing it closes the app.',
  '  A training or calibration already started keeps running on its own.',
  '',
].join('\r\n');

const STARTED: Partial<Record<JobKind, string>> = {
  train: 'Training started',
  calibrate: 'Calibration started',
  catalog: 'Catalog export check started',
  refine: 'Profile improvement started',
};

/** One line for a job the app started, with the local time; undefined for jobs not worth a line. */
export function jobLine(kind: JobKind, at: Date): string | undefined {
  const what = STARTED[kind];
  if (!what) return undefined;
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `  ${time}  ${what}.${kind === 'catalog' ? '' : ' It keeps running even if this window closes.'}\r\n`;
}

export type ConsoleWrite = (text: string) => void;

/** Writes to the console the process is attached to; a no-op without one, or off Windows. */
export function consoleWriter(platform: NodeJS.Platform = process.platform, write: ConsoleWrite = (t) => writeFileSync('CONOUT$', t)): ConsoleWrite {
  if (platform !== 'win32') return () => {};
  return (text) => {
    try {
      write(text);
    } catch {
      // No console attached (started some other way): nothing to say it to.
    }
  };
}
