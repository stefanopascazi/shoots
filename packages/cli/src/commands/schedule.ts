/**
 * `shoots schedule` — hand the daily refine to the operating system.
 *
 * The develop predictor only improves when a developed shoot is folded back in,
 * and that step is the one a photographer forgets: it pays off next month, not
 * tonight. So it goes in the machine's own scheduler — cron on Linux and macOS,
 * the Task Scheduler on Windows — and runs once a day.
 *
 * Three commands, plus the one the scheduler calls:
 *   install    register (or re-time) the daily job
 *   status     what the OS holds, and which shoots the next run would touch
 *   uninstall  remove it
 *   run        do a pass now — what the scheduler invokes
 *
 * The job takes no paths. It re-reads them from the working directories
 * `develop edit` left under `~/.shoots` every time it wakes up, and skips a shoot
 * that has been moved, cleaned away, or that nobody has touched since the last
 * pass. Both halves of that are load-bearing; schedule/shoots.ts says why.
 */
import path from 'node:path';
import type { Command } from 'commander';
import { shootsHome } from '@shoots/core';
import { logError, makeIo, printHuman, printJson } from '../io.js';
import { resolveBackend } from '../schedule/backends/index.js';
import { collectShoots, SKIP_REASONS } from '../schedule/shoots.js';
import { runSchedule, reportShoots, type ScheduleRunArgs } from '../schedule/run.js';
import { isStandaloneBinary, selfInvocation, type Invocation } from '../selfInvoke.js';
import {
  JOB_COMMAND,
  parseTime,
  type ScheduleBackend,
  type ScheduleSpec,
  type ScheduleState,
} from '../schedule/types.js';

const DEFAULT_AT = '03:00';

interface InstallArgs {
  at: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

interface PlainArgs {
  json?: boolean;
  verbose?: boolean;
}

export function registerScheduleCommand(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('Run `develop refine` daily, unattended, via the OS scheduler (cron / Task Scheduler)');

  schedule
    .command('install')
    .description('Register the daily refine with this machine\'s scheduler (re-run to change the time)')
    .option('--at <HH:MM>', 'local time to run at', DEFAULT_AT)
    .option('--dry-run', 'print the job that would be registered, register nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runInstall);

  schedule
    .command('status')
    .description('Whether the daily job is registered, and which shoots the next run would refine')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runStatus);

  schedule
    .command('uninstall')
    .description('Remove the daily job (the profile, the journal and the cached shoots are untouched)')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runUninstall);

  schedule
    .command('run')
    .description('Refine every cached shoot that has changed since the last pass — what the scheduler calls')
    .option('--force', 'refine every cached shoot, including the unchanged ones')
    .option('--editor <id>', "which editor's develop settings to read")
    .option('--home <dir>', 'shoots home to use (the installed job passes the one it was installed with)')
    .option('--dry-run', 'report what would run, refine nothing')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action((opts: ScheduleRunArgs) => runSchedule(opts));
}

/** The backend for this platform, or an explanation of why there is none. */
function requireBackend(): ScheduleBackend | null {
  const backend = resolveBackend();
  if (backend) return backend;
  logError(
    `no scheduler backend for ${process.platform} — run \`shoots schedule run\` from your own ` +
      'scheduler instead; it is the whole job and needs no arguments',
  );
  process.exitCode = 2;
  return null;
}

/**
 * The command line to hand the scheduler.
 *
 * `SHOOTS_HOME` is baked in when it is set, because cron and the Task Scheduler
 * both start from an environment that has never seen the photographer's shell
 * profile — a job that silently used `~/.shoots` while every interactive command
 * used the override would refine nothing and explain nothing.
 */
function jobInvocation(): Invocation {
  const args: string[] = [...JOB_COMMAND];
  if (process.env.SHOOTS_HOME) args.push('--home', shootsHome());
  return selfInvocation(args);
}

async function runInstall(args: InstallArgs): Promise<void> {
  const io = makeIo(args);
  if (!parseTime(args.at)) {
    logError(`invalid --at '${args.at}' — expected a 24-hour local time like 03:00`);
    process.exitCode = 2;
    return;
  }
  const backend = requireBackend();
  if (!backend) return;

  const { command, args: jobArgs } = jobInvocation();
  const spec: ScheduleSpec = { at: args.at, command, args: jobArgs };
  const line = [command, ...jobArgs].join(' ');

  // Running from sources is legitimate in development but a poor thing to
  // register for the next six months: `npm run build` replaces dist/cli.js and
  // nothing tells the scheduler. Worth one warning, not a refusal.
  const notes = isStandaloneBinary()
    ? []
    : ['This build runs under an interpreter, so the job points at dist/cli.js — reinstall it after moving or rebuilding.'];

  if (args.dryRun) {
    if (io.json) printJson({ command: 'schedule-install', dryRun: true, backend: backend.id, at: args.at, job: line, notes });
    else {
      printHuman(io, 'Dry run — nothing registered.\n');
      printHuman(io, `  scheduler  ${backend.label}`);
      printHuman(io, `  daily at   ${args.at} (local time)`);
      printHuman(io, `  job        ${line}`);
      for (const note of [...notes, ...backend.caveats()]) printHuman(io, `\n  ${note}`);
    }
    return;
  }

  try {
    await backend.install(spec);
  } catch (err) {
    logError(`could not register the job: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const shoots = await collectShoots();
  if (io.json) {
    printJson({
      command: 'schedule-install',
      backend: backend.id, at: args.at, job: line, notes,
      caveats: backend.caveats(),
      cachedShoots: shoots.length,
    });
    return;
  }

  printHuman(io, `Registered with ${backend.label}: \`develop refine\` daily at ${args.at}.`);
  printHuman(io, `  job  ${line}`);
  printHuman(io, `\nIt refines whichever shoots are still cached under ${path.join(shootsHome(), 'develop')} when it`);
  printHuman(io, 'wakes up — nothing is baked into the schedule, so moving or cleaning a shoot');
  printHuman(io, 'simply takes it out. A shoot nobody has touched since the last pass is skipped.');
  printHuman(io, `\nRight now that is ${shoots.filter((s) => !s.skip).length} shoot(s) due of ${shoots.length} cached.`);
  for (const note of [...notes, ...backend.caveats()]) printHuman(io, `\n  ${note}`);
  printHuman(io, '\nTry it once by hand first: `shoots schedule run --dry-run`.');
}

async function runStatus(args: PlainArgs): Promise<void> {
  const io = makeIo(args);
  const backend = resolveBackend();
  const shoots = await collectShoots();

  let state: ScheduleState | null = backend ? null : { installed: false };
  let readError: string | null = null;
  if (backend) {
    try {
      state = await backend.read();
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
      state = { installed: false };
    }
  }

  if (io.json) {
    printJson({
      command: 'schedule-status',
      backend: backend?.id ?? null,
      supported: backend !== null,
      error: readError,
      schedule: state,
      shoots: shoots.map((s) => ({
        shoot: s.name, source: s.source, workDir: s.workDir,
        files: s.files, present: s.present,
        due: !s.skip, reason: s.skip ? SKIP_REASONS[s.skip] : undefined,
        lastRefine: s.last,
      })),
    });
    return;
  }

  if (!backend) {
    printHuman(io, `Scheduler         none for ${process.platform} — call \`shoots schedule run\` from your own`);
  } else if (readError) {
    printHuman(io, `Scheduler         ${backend.label} — could not be read: ${readError}`);
  } else if (!state?.installed) {
    printHuman(io, `Scheduler         ${backend.label}, no job registered`);
    printHuman(io, '                  `shoots schedule install` adds it');
  } else {
    printHuman(io, `Scheduler         ${backend.label}`);
    printHuman(io, `Daily job         ${state.at ?? 'time unknown'}${state.disabled ? '  ⚠ disabled' : ''}`);
    if (state.command) printHuman(io, `                  ${state.command}`);
    for (const note of state.notes ?? []) printHuman(io, `                  ${note}`);
  }

  printHuman(io, '');
  reportShoots(io, shoots);
  if (shoots.some((s) => s.skip === 'unchanged')) {
    printHuman(io, '\n"unchanged" is not a nicety: re-refining a shoot nothing has touched would');
    printHuman(io, 're-record the same measurements as in-sample and discard the calibration');
    printHuman(io, 'measured against the profile it then replaces. `--force` overrides it.');
  }
}

async function runUninstall(args: PlainArgs): Promise<void> {
  const io = makeIo(args);
  const backend = requireBackend();
  if (!backend) return;

  let removed: boolean;
  try {
    removed = await backend.remove();
  } catch (err) {
    logError(`could not remove the job: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (io.json) {
    printJson({ command: 'schedule-uninstall', backend: backend.id, removed });
    return;
  }
  printHuman(io, removed
    ? `Removed the daily refine from ${backend.label}.`
    : `Nothing to remove — ${backend.label} holds no shoots job.`);
  if (removed) {
    printHuman(io, 'The profile, the feedback journal and the cached shoots are untouched;');
    printHuman(io, '`shoots develop refine <shoot>` still works by hand.');
  }
}
