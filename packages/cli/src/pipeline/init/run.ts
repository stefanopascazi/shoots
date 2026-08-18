/**
 * `shoots pipeline init` — the wizard's plumbing: pick a front-end, collect the
 * answers, render the file, check it against the real command tree, write it.
 *
 * The check before writing is not ceremony. A generated file that a later
 * `shoots pipeline` rejects would teach exactly the wrong lesson to the person
 * this command exists for, so the draft is parsed and resolved here — against
 * commander's own definitions — and anything it complains about is said now.
 */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import {
  buildDraft,
  draftHeader,
  findPreset,
  parsePipelineConfig,
  presetAnswers,
  PRESETS,
  renderPipelineYaml,
  selectedSteps,
  wizardQuestions,
  PipelineConfigError,
  type Answers,
  type CatalogContext,
} from '@shoots/core';
import { logError, logWarn, makeIo, printHuman, printJson } from '../../io.js';
import { resolvePipeline } from '../resolve.js';
import { buildCatalogContext } from './context.js';
import { confirm, createLineReader, runPlainWizard } from './plainPrompt.js';

export interface PipelineInitOptions {
  var: string[];
  template?: string;
  name?: string;
  plain?: boolean;
  stdout?: boolean;
  force?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export const DEFAULT_INIT_FILE = 'shoots-pipeline.yaml';

/** `--var shoot=D:/x` pre-answers the `shoot` variable question. */
function answersFromVars(pairs: readonly string[]): Answers {
  const answers: Answers = {};
  const bad: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      bad.push(pair);
      continue;
    }
    answers[`vars.${pair.slice(0, eq).trim()}`] = pair.slice(eq + 1);
  }
  if (bad.length > 0) throw new PipelineConfigError(bad.map((p) => `--var '${p}' must be name=value`));
  return answers;
}

/** Overrides that never reached a question would otherwise vanish silently. */
function warnUnusedVars(answers: Answers, overrides: Answers, context: CatalogContext): void {
  const asked = new Set(wizardQuestions(answers, context).map((question) => question.id));
  for (const id of Object.keys(overrides)) {
    if (!asked.has(id)) logWarn(`--var ${id.replace(/^vars\./, '')} is not used by the steps you picked`);
  }
}

/** Parse + resolve the generated text exactly as `shoots pipeline` would. */
function validateGenerated(yaml: string, program: Command): string[] {
  try {
    const config = parsePipelineConfig(yaml);
    return resolvePipeline(program, config).issues;
  } catch (err) {
    if (err instanceof PipelineConfigError) return err.issues;
    throw err;
  }
}

export async function runPipelineInit(
  target: string | undefined,
  options: PipelineInitOptions,
  program: Command,
): Promise<void> {
  const io = makeIo(options);
  const file = path.resolve(target ?? DEFAULT_INIT_FILE);
  const fileName = path.basename(file);
  const exists = existsSync(file);

  let overrides: Answers;
  try {
    overrides = answersFromVars(options.var);
  } catch (err) {
    if (!(err instanceof PipelineConfigError)) throw err;
    for (const issue of err.issues) logError(issue);
    process.exitCode = 2;
    return;
  }
  if (options.name) overrides.name = options.name;

  const context = await buildCatalogContext();

  let answers: Answers | null;
  if (options.template) {
    const preset = findPreset(options.template);
    if (!preset) {
      logError(`unknown template '${options.template}' (available: ${PRESETS.map((p) => p.id).join(', ')})`);
      process.exitCode = 2;
      return;
    }
    if (preset.steps.length === 0) {
      logError(`template '${preset.id}' has no steps of its own — run \`shoots pipeline init\` and pick them`);
      process.exitCode = 2;
      return;
    }
    if (exists && !options.force && !options.stdout) {
      logError(`${fileName} already exists — pass --force to replace it`);
      process.exitCode = 2;
      return;
    }
    answers = presetAnswers(preset.id, context, overrides);
  } else if (options.plain || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (!process.stdin.isTTY) {
      // Also the path from inside the `shoots` shell, which runs commands with
      // no stdin at all — hence the "outside" half of the hint.
      logError(
        'pipeline init needs a terminal to ask its questions — run it outside the shoots shell, ' +
          'or use --template <name> for an unattended file',
      );
      process.exitCode = 2;
      return;
    }
    const reader = createLineReader();
    try {
      answers = await runPlainWizard(context, reader, overrides);
      if (answers && !options.stdout) {
        const question = exists ? `Replace ${fileName}?` : `Write ${fileName}?`;
        if (!(await confirm(reader, `\n${question}`, true))) answers = null;
      }
    } finally {
      reader.close();
    }
  } else {
    answers = await runInkWizard(context, overrides, fileName, exists);
  }

  if (!answers) {
    printHuman(io, 'Nothing written.');
    return;
  }

  warnUnusedVars(answers, overrides, context);

  const draft = buildDraft(answers, context);
  const yaml = renderPipelineYaml(draft, { header: draftHeader(fileName) });

  const issues = validateGenerated(yaml, program);
  for (const issue of issues) logWarn(issue);

  if (options.stdout) {
    process.stdout.write(yaml);
    return;
  }

  await writeFile(file, yaml, 'utf8');

  if (io.json) {
    printJson({
      command: 'pipeline init',
      file,
      pipeline: draft.name ?? null,
      steps: draft.steps.map((step) => ({ id: step.id, run: step.run })),
      issues,
    });
    return;
  }

  const count = selectedSteps(answers).length;
  printHuman(io, `\n✓ ${exists ? 'replaced' : 'wrote'} ${fileName} — ${count} step(s)`);
  printHuman(io, '\nNext:');
  printHuman(io, `  shoots pipeline ${fileName} --dry-run   # see the commands, run nothing`);
  printHuman(io, `  shoots pipeline ${fileName}`);
}

/** Loaded lazily: the Ink screen must not cost anything on the batch path. */
async function runInkWizard(
  context: CatalogContext,
  initial: Answers,
  fileName: string,
  exists: boolean,
): Promise<Answers | null> {
  const [{ render }, { InitWizard }, React] = await Promise.all([
    import('ink'),
    import('./InitWizard.js'),
    import('react'),
  ]);

  let result: Answers | null = null;
  const app = render(
    React.createElement(InitWizard, {
      context,
      initial,
      fileName,
      exists,
      onDone: (answers: Answers | null) => {
        result = answers;
      },
    }),
  );
  await app.waitUntilExit();
  return result;
}
