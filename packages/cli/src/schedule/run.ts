/**
 * `shoots schedule run` — the thing the operating system actually calls.
 *
 * One pass over the cached shoots, `develop refine` on each one that has moved
 * since last time, and a line in `~/.shoots/logs/schedule.log` either way. It
 * takes no paths on purpose: see schedule/shoots.ts for why the list is
 * re-derived on every run rather than baked into the job.
 *
 * Each refine runs as a child process rather than in-process. Three reasons, all
 * of which matter in something nobody is watching: one shoot that throws cannot
 * take the rest of the night with it, the child's exit code is the unambiguous
 * verdict on that shoot, and its full report — which `refine` writes to stdout
 * and stderr as it goes — can be captured into the log verbatim instead of being
 * interleaved with everyone else's.
 *
 * Runnable by hand, and worth running by hand once before trusting it to cron.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { developProfilePath, logsDir } from '@shoots/core';
import { DEFAULT_EDITOR, EDITOR_IDS } from '../develop/adapters/registry.js';
import { logError, makeIo, printHuman, printJson } from '../io.js';
import { selfInvocation } from '../selfInvoke.js';
import { collectShoots, writeState, SKIP_REASONS, type RefinableShoot } from './shoots.js';
import type { DevelopProfile } from '../develop/types.js';

/** Beyond this the log is rotated to `.1`, keeping one generation. */
const MAX_LOG_BYTES = 5_000_000;

export interface ScheduleRunArgs {
  editor?: string;
  /** Refine every cached shoot, including the ones nothing has touched. */
  force?: boolean;
  /** Report what would run, refine nothing. */
  dryRun?: boolean;
  /** The shoots home the installed job was registered with. */
  home?: string;
  json?: boolean;
  verbose?: boolean;
}

interface Outcome {
  shoot: string;
  source: string | null;
  status: 'refined' | 'failed' | 'skipped';
  exitCode?: number;
  reason?: string;
}

function logPath(): string {
  return path.join(logsDir(), 'schedule.log');
}

/**
 * Append to the log, rotating first if it has grown past its ceiling. A daily
 * job left alone for years would otherwise turn a full refine report into an
 * unbounded file on a disk that is already full of photographs.
 */
async function appendLog(lines: string): Promise<void> {
  const file = logPath();
  await mkdir(path.dirname(file), { recursive: true });
  const size = (await stat(file).catch(() => null))?.size ?? 0;
  if (size > MAX_LOG_BYTES) await rename(file, `${file}.1`).catch(() => {});
  await appendFile(file, lines.endsWith('\n') ? lines : `${lines}\n`, 'utf8');
}

/**
 * The profile's own name, so a refit keeps calling it what the photographer
 * called it. `learn` passes `--name` straight through to `train`, which writes it
 * into the new profile — defaulting blindly would quietly rename their style.
 */
async function profileName(): Promise<string> {
  try {
    const profile = JSON.parse(await readFile(developProfilePath(), 'utf8')) as DevelopProfile;
    return profile.name || 'my-style';
  } catch {
    return 'my-style';
  }
}

/** Run `develop refine` on one shoot, capturing everything it says. */
async function refine(shoot: RefinableShoot, editorId: string, name: string): Promise<{ code: number; output: string }> {
  const { command, args } = selfInvocation([
    'develop', 'refine', shoot.source!,
    '--shoot-dir', shoot.workDir,
    '--editor', editorId,
    '--name', name,
  ]);

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer): void => { output += chunk.toString('utf8'); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ code: 1, output: `${output}failed to launch: ${err.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

export async function runSchedule(args: ScheduleRunArgs): Promise<void> {
  // Before anything resolves a path: cron and the Task Scheduler start from a
  // bare environment, so an installed job carries the home it was installed with.
  if (args.home) process.env.SHOOTS_HOME = path.resolve(args.home);

  const io = makeIo(args);
  const editorId = args.editor ?? DEFAULT_EDITOR;
  if (!EDITOR_IDS.includes(editorId)) {
    logError(`unknown --editor '${editorId}' (available: ${EDITOR_IDS.join(', ')})`);
    process.exitCode = 2;
    return;
  }

  const startedAt = new Date();
  const shoots = await collectShoots({ editor: editorId, force: args.force });
  const due = shoots.filter((s) => !s.skip);

  if (args.dryRun) {
    const plan = {
      command: 'schedule-run' as const,
      dryRun: true,
      cached: shoots.length,
      due: due.length,
      shoots: shoots.map((s) => ({
        shoot: s.name, source: s.source, present: s.present, files: s.files,
        due: !s.skip, reason: s.skip ? SKIP_REASONS[s.skip] : undefined,
        lastRefine: s.last?.at,
      })),
    };
    if (io.json) printJson(plan);
    else {
      printHuman(io, 'Dry run — nothing refined.\n');
      reportShoots(io, shoots);
    }
    return;
  }

  if (!existsSync(developProfilePath())) {
    // Nothing downstream can work without it, and saying so is more useful than
    // three identical failures in the log.
    const message = 'no profile: run `shoots develop init <catalog>` first';
    await appendLog(`\n=== ${startedAt.toISOString()} - skipped, ${message}`);
    if (io.json) printJson({ command: 'schedule-run', at: startedAt.toISOString(), error: message, shoots: [] });
    else logError(message);
    process.exitCode = 2;
    return;
  }

  const name = await profileName();
  const outcomes: Outcome[] = shoots
    .filter((s) => s.skip)
    .map((s) => ({ shoot: s.name, source: s.source, status: 'skipped', reason: SKIP_REASONS[s.skip!] }));

  // Plain ASCII in the log lines we write ourselves: this file is read by
  // whatever is at hand, and half the tools on Windows still open a UTF-8 file
  // as the system codepage. The refine transcript below carries what it carries.
  const transcript: string[] = [
    '',
    `=== ${startedAt.toISOString()} - ${due.length} of ${shoots.length} cached shoot(s) due`,
  ];
  for (const s of shoots) {
    if (s.skip) transcript.push(`--- ${s.name}: skipped (${SKIP_REASONS[s.skip]})`);
  }

  for (const shoot of due) {
    printHuman(io, `\n═══ ${shoot.name} ═══`);
    const { code, output } = await refine(shoot, editorId, name);
    const outcome: Outcome = {
      shoot: shoot.name,
      source: shoot.source,
      status: code === 0 ? 'refined' : 'failed',
      exitCode: code,
    };
    outcomes.push(outcome);

    transcript.push(`--- ${shoot.name}: exit ${code} (${shoot.source})`, output.trimEnd());
    if (!io.json) process.stderr.write(output);

    // Recorded on failure too: an undeveloped shoot fails identically every
    // night, and only a change on disk makes it worth trying again.
    await writeState(shoot.workDir, {
      at: new Date().toISOString(),
      fingerprint: shoot.fingerprint,
      outcome: outcome.status === 'refined' ? 'refined' : 'failed',
      exitCode: code,
    });
  }

  const refined = outcomes.filter((o) => o.status === 'refined').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  transcript.push(`=== done: ${refined} refined, ${failed} failed, ${outcomes.length - refined - failed} skipped`);
  await appendLog(transcript.join('\n'));

  if (failed > 0) process.exitCode = 1;

  if (io.json) {
    printJson({
      command: 'schedule-run',
      at: startedAt.toISOString(),
      log: logPath(),
      refined, failed, skipped: outcomes.length - refined - failed,
      shoots: outcomes,
    });
    return;
  }

  printHuman(io, `\n${refined} refined, ${failed} failed, ${outcomes.length - refined - failed} skipped.`);
  if (due.length === 0 && shoots.length > 0) {
    printHuman(io, 'Nothing had changed since the last run — see `shoots schedule status`.');
  }
  printHuman(io, `Full transcript: ${logPath()}`);
}

/** The per-shoot table, shared by `schedule run --dry-run` and `schedule status`. */
export function reportShoots(io: ReturnType<typeof makeIo>, shoots: readonly RefinableShoot[]): void {
  if (shoots.length === 0) {
    printHuman(io, 'No cached shoots — `shoots develop edit <shoot>` puts one here.');
    return;
  }
  printHuman(io, `Cached shoots     ${shoots.length}`);
  for (const s of shoots) {
    const state = s.skip ? `skip · ${SKIP_REASONS[s.skip]}` : 'due';
    printHuman(io, `  ${s.name.padEnd(28)} ${state}`);
    printHuman(io, `  ${''.padEnd(28)} ${s.source ?? '(unknown folder)'}${s.files ? `  ${s.present}/${s.files} files present` : ''}`);
    if (s.last) {
      printHuman(io, `  ${''.padEnd(28)} last refine ${s.last.at} (${s.last.outcome})`);
    }
  }
}
