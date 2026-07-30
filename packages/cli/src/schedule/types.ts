/**
 * The seam between shoots and the operating system's own scheduler.
 *
 * Every OS already runs unattended work, and none of them agree on how: cron
 * keeps a per-user text file, the Windows Task Scheduler keeps a registered
 * object described by XML. Rather than ship a daemon of our own — a process that
 * has to be kept alive, supervised and updated — we register one daily job with
 * whatever the machine already has and get startup, catch-up after sleep and
 * survival across reboots for free.
 *
 * The backend interface is deliberately four small operations. Anything richer
 * (weekly schedules, multiple jobs, calendars) would have to be expressed in two
 * scheduler dialects at once, and one daily job is what the workflow needs: the
 * photographs are developed in the evening, the model catches up overnight.
 */

/** The single job we register, as arguments to this build. */
export const JOB_COMMAND = ['schedule', 'run'] as const;

export interface ScheduleSpec {
  /** Local wall-clock time to fire at, `HH:MM`. */
  at: string;
  /** Absolute path to the executable the scheduler must run. */
  command: string;
  /** Its arguments, already split — no backend does its own word splitting. */
  args: string[];
}

export interface ScheduleState {
  installed: boolean;
  /** The time the OS says it will fire at, when it can be read back. */
  at?: string;
  /** The command line the OS holds, for the report — not re-parsed. */
  command?: string;
  /** The job exists but will not fire (disabled task, commented-out line). */
  disabled?: boolean;
  /** Whatever else the backend can tell us, one line each. */
  notes?: string[];
}

export interface ScheduleBackend {
  /** Stable id, reported in `--json`. */
  id: 'cron' | 'schtasks';
  /** What to call it in front of a human. */
  label: string;
  /** Register or replace the job. Idempotent by construction. */
  install(spec: ScheduleSpec): Promise<void>;
  /** What the OS currently holds. Never throws on "nothing there". */
  read(): Promise<ScheduleState>;
  /** Remove the job; `false` when there was nothing to remove. */
  remove(): Promise<boolean>;
  /** Platform truths the photographer has to know after installing. */
  caveats(): string[];
}

/** Parse and validate a `HH:MM` wall-clock time. */
export function parseTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = parseInt(m[1]!, 10);
  const minute = parseInt(m[2]!, 10);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export const formatTime = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
