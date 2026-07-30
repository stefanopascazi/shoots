/** Which scheduler this machine has. */
import { cronBackend } from './cron.js';
import { schtasksBackend } from './schtasks.js';
import type { ScheduleBackend } from '../types.js';

export function resolveBackend(): ScheduleBackend | null {
  if (process.platform === 'win32') return schtasksBackend;
  // cron is the only scheduler present on every Linux and macOS install worth
  // assuming. systemd timers and launchd agents are both better on the systems
  // that have them, and both would need a second dialect for no behaviour the
  // photographer can see.
  if (process.platform === 'linux' || process.platform === 'darwin') return cronBackend;
  return null;
}
