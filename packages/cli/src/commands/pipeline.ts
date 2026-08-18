/**
 * shoots pipeline <config.yaml>
 *
 * Runs a list of shoots commands, in the order the file declares them, sharing
 * one set of variables. The two shapes this exists for are the develop pipeline
 * (import → rename → exif → rate → cull → develop edit) and the model-side
 * chains (develop export → train, or the whole refine cycle) — both of which are
 * the same commands, over the same paths, every single time.
 *
 * The command itself is thin: load and interpolate (@shoots/core), resolve
 * against the commander tree (pipeline/resolve.ts), run as child processes
 * (pipeline/exec.ts), report. Nothing about any individual command lives here.
 *
 * `pipeline init` (pipeline/init/) writes one of these files by asking
 * questions, for the photographer who has a workflow but not the YAML.
 */
import path from 'node:path';
import type { Command } from 'commander';
import { loadPipelineConfig, parseVarOverrides, PipelineConfigError } from '@shoots/core';
import { logError, makeIo, printHuman, printJson } from '../io.js';
import { resolvePipeline, type ResolvedStep } from '../pipeline/resolve.js';
import { formatDuration, runSteps, type StepReport } from '../pipeline/exec.js';
import { runPipelineInit, DEFAULT_INIT_FILE, type PipelineInitOptions } from '../pipeline/init/run.js';

interface PipelineOptions {
  var: string[];
  from?: string;
  dryRun?: boolean;
  continueOnError?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** Collect a repeatable `--var name=value`. */
const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function registerPipelineCommand(program: Command): void {
  const pipeline = program
    .command('pipeline')
    .description(
      'Run a YAML pipeline: shoots commands in order, sharing variables (import → … → develop, export → train, …)',
    );

  // `run` is the default subcommand, so `shoots pipeline my.yaml` — the only
  // form there was before `init` existed — still means exactly what it did.
  pipeline
    .command('run', { isDefault: true })
    .description('Run a pipeline file')
    .argument('<config>', 'pipeline YAML file')
    .option('--var <name=value>', 'override a variable declared in the file (repeatable)', collect, [])
    .option('--from <id>', 'resume: skip every step before this one')
    .option('--dry-run', 'validate the file and print the command lines, run nothing')
    .option('--continue-on-error', 'keep going after a failing step, whatever the file says')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action((config: string, options: PipelineOptions) => runPipeline(config, options, program));

  pipeline
    .command('init')
    .description('Answer a few questions and get a pipeline file — no YAML to write')
    .argument('[file]', 'file to write', DEFAULT_INIT_FILE)
    .option('--template <name>', 'skip the questions: ingest | cull-rate | develop-train, all defaults')
    .option('--var <name=value>', 'answer a variable up front, e.g. --var shoot=D:/Shoots/smith (repeatable)', collect, [])
    .option('--name <name>', 'pipeline name to write into the file')
    .option('--plain', 'ask line by line instead of the full-screen wizard')
    .option('--stdout', 'print the file instead of writing it')
    .option('--force', 'replace the file if it already exists')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action((file: string, options: PipelineInitOptions) => runPipelineInit(file, options, program));
}

function reportIssues(issues: readonly string[], source: string): void {
  logError(`${issues.length} problem(s) in ${source}:`);
  for (const issue of issues) process.stderr.write(`  · ${issue}\n`);
  process.exitCode = 2;
}

/** Apply `--from`: everything before the named step is skipped, not dropped. */
function applyFrom(steps: ResolvedStep[], from: string): ResolvedStep[] | null {
  const at = steps.findIndex((s) => s.step.id === from);
  if (at < 0) return null;
  return steps.map((s, i) => (i < at && !s.skip ? { ...s, skip: `before --from ${from}` } : s));
}

export async function runPipeline(configPath: string, options: PipelineOptions, program: Command): Promise<void> {
  const io = makeIo(options);
  const file = path.resolve(configPath);

  let config;
  try {
    config = await loadPipelineConfig(file, { vars: parseVarOverrides(options.var) });
  } catch (err) {
    if (err instanceof PipelineConfigError) {
      reportIssues(err.issues, path.basename(file));
      return;
    }
    throw err;
  }

  const { steps: resolved, issues } = resolvePipeline(program, config);
  if (issues.length > 0) {
    reportIssues(issues, path.basename(file));
    return;
  }

  let steps = resolved;
  if (options.from) {
    const filtered = applyFrom(steps, options.from);
    if (!filtered) {
      logError(
        `--from '${options.from}' matches no step (ids: ${steps.map((s) => s.step.id).join(', ')})`,
      );
      process.exitCode = 2;
      return;
    }
    steps = filtered;
  }
  if (options.continueOnError) {
    steps = steps.map((s) => ({ ...s, step: { ...s.step, continueOnError: true } }));
  }

  const label = config.name ?? path.basename(file);
  const runnable = steps.filter((s) => !s.skip);

  if (options.dryRun) {
    if (io.json) {
      printJson({
        command: 'pipeline',
        dryRun: true,
        pipeline: label,
        file,
        vars: config.vars,
        steps: steps.map((s) => ({
          id: s.step.id,
          run: s.step.run,
          command: s.display,
          skipped: s.skip ?? null,
        })),
      });
      return;
    }
    printHuman(io, `Dry run — ${label}: ${runnable.length} step(s), nothing executed.\n`);
    let n = 0;
    for (const step of steps) {
      if (step.skip) {
        printHuman(io, `   ·   ${step.step.id}  (skipped: ${step.skip})`);
        continue;
      }
      printHuman(io, `  [${++n}/${runnable.length}] ${step.step.id}`);
      printHuman(io, `        ${step.display}`);
    }
    return;
  }

  if (runnable.length === 0) {
    logError('every step is skipped — nothing to run');
    process.exitCode = 2;
    return;
  }

  printHuman(io, `▶ ${label} — ${runnable.length} step(s)\n`);
  const started = Date.now();

  const { reports, ok } = await runSteps(steps, {
    cwd: process.cwd(),
    quietStdout: io.json,
    onStepStart: (step, position, total) => {
      const line = `[${position}/${total}] ${step.step.id}\n      ${step.display}\n`;
      if (io.json) process.stderr.write(line);
      else process.stdout.write(`\n${line}`);
    },
    onStepEnd: (report: StepReport) => {
      if (report.status === 'ok') return;
      logError(`step '${report.id}' failed (exit ${report.exitCode})`);
    },
  });

  const elapsed = Date.now() - started;

  if (io.json) {
    printJson({ command: 'pipeline', pipeline: label, file, ok, durationMs: elapsed, steps: reports });
    if (!ok) process.exitCode = 1;
    return;
  }

  printHuman(io, `\n── ${label} ${ok ? 'complete' : 'failed'} in ${formatDuration(elapsed)}`);
  for (const report of reports) {
    const mark = report.status === 'ok' ? '✓' : report.status === 'failed' ? '✗' : '·';
    const detail =
      report.status === 'skipped'
        ? `skipped (${report.reason})`
        : `${report.status === 'ok' ? '' : `exit ${report.exitCode}, `}${formatDuration(report.durationMs)}`;
    printHuman(io, `  ${mark} ${report.id.padEnd(24)} ${detail}`);
  }
  if (!ok) {
    const failed = reports.find((r) => r.status === 'failed');
    if (failed) printHuman(io, `\nFix it, then resume with \`--from ${failed.id}\`.`);
    process.exitCode = 1;
  }
}
