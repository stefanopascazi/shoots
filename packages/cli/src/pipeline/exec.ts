/**
 * Running the resolved steps, one after another.
 *
 * Each step is this same build, re-invoked as a child process — the mechanism
 * the interactive shell already uses (shell/runner.ts). In-process dispatch
 * would be faster by a second per step and wrong in every other way: commands
 * signal failure through `process.exitCode`, several of them hold ONNX sessions
 * and libvips thread pools that are meant to die with the process, and a step
 * that crashes must not take the pipeline's own report down with it. A child
 * process gives all of that for free, and it is what a photographer running the
 * same commands by hand would get.
 *
 * stdout is inherited so each step keeps its own progress view — except under
 * `--json`, where the pipeline owns stdout and a step's output is forwarded to
 * stderr instead.
 */
import { spawn } from 'node:child_process';
import { selfArgv } from '../selfInvoke.js';
import type { ResolvedStep } from './resolve.js';

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface StepReport {
  id: string;
  run: string;
  command: string;
  status: StepStatus;
  exitCode: number | null;
  durationMs: number;
  /** Why it was skipped: disabled in the file, before `--from`, or after a failure. */
  reason?: string;
}

export interface RunOptions {
  cwd: string;
  /** Forward step output to stderr instead of inheriting stdout. */
  quietStdout: boolean;
  onStepStart: (step: ResolvedStep, position: number, total: number) => void;
  onStepEnd: (report: StepReport) => void;
}

function runStep(argv: string[], options: RunOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, selfArgv(argv), {
      cwd: options.cwd,
      stdio: ['ignore', options.quietStdout ? 'pipe' : 'inherit', 'inherit'],
    });
    child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', (err) => {
      process.stderr.write(`error: failed to launch step — ${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export interface RunResult {
  reports: StepReport[];
  ok: boolean;
}

/**
 * Execute the steps in order, stopping at the first failure unless the step
 * asked to be survivable.
 *
 * Steps after a stop are reported as skipped rather than dropped: the report is
 * how the photographer sees what did *not* happen to their photographs, and a
 * pipeline that silently ends at step 3 of 7 does not communicate that.
 */
export async function runSteps(steps: readonly ResolvedStep[], options: RunOptions): Promise<RunResult> {
  const reports: StepReport[] = [];
  let ok = true;
  let stopped = false;
  const total = steps.filter((s) => !s.skip).length;
  let position = 0;

  for (const resolved of steps) {
    const base = { id: resolved.step.id, run: resolved.step.run, command: resolved.display };

    if (resolved.skip) {
      reports.push({ ...base, status: 'skipped', exitCode: null, durationMs: 0, reason: resolved.skip });
      continue;
    }
    if (stopped) {
      reports.push({ ...base, status: 'skipped', exitCode: null, durationMs: 0, reason: 'earlier step failed' });
      continue;
    }

    position++;
    options.onStepStart(resolved, position, total);
    const started = Date.now();
    const exitCode = await runStep(resolved.argv, options);
    const report: StepReport = {
      ...base,
      status: exitCode === 0 ? 'ok' : 'failed',
      exitCode,
      durationMs: Date.now() - started,
    };
    reports.push(report);
    options.onStepEnd(report);

    if (exitCode !== 0) {
      ok = false;
      if (!resolved.step.continueOnError) stopped = true;
    }
  }

  return { reports, ok };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`;
}
