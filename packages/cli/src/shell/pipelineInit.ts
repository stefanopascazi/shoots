/**
 * `/pipeline init` inside the shell.
 *
 * The shell owns the terminal, so a child process cannot ask anything: it runs
 * commands with no stdin at all. Rather than sending people out of the shell to
 * write a pipeline file, the wizard runs in-process here — the same component
 * the CLI renders, over the same questions, writing the same validated file.
 * This module is the non-React half: arguments in, a session out, answers in, a
 * written file out.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Answers, CatalogContext } from '@shoots/core';
import { buildProgram } from '../program.js';
import { buildCatalogContext } from '../pipeline/init/context.js';
import { DEFAULT_INIT_FILE, writePipelineDraft, type WrittenPipeline } from '../pipeline/init/run.js';

export interface InitSession {
  /** Absolute path the file will be written to. */
  file: string;
  fileName: string;
  /** The file is already there; the wizard says so before writing. */
  exists: boolean;
  /** Answers supplied on the command line (`--var`, `--name`). */
  initial: Answers;
  context: CatalogContext;
}

/** Flags that only make sense out-of-process; the shell runs those as a child. */
export const NON_INTERACTIVE_INIT_FLAGS = ['--template', '--stdout', '--plain'];

export const isInteractiveInit = (args: readonly string[]): boolean =>
  args[0] === 'init' && !args.some((arg) => NON_INTERACTIVE_INIT_FLAGS.includes(arg));

export class InitArgumentError extends Error {}

/** `[file] [--var k=v]… [--name n]` — the subset the in-shell wizard accepts. */
export function parseInitArgs(args: readonly string[], cwd: string): { file: string; initial: Answers } {
  const initial: Answers = {};
  let target: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--var') {
      const pair = args[++i];
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq <= 0) throw new InitArgumentError(`--var needs name=value, got '${pair ?? ''}'`);
      initial[`vars.${pair.slice(0, eq).trim()}`] = pair.slice(eq + 1);
      continue;
    }
    if (arg === '--name') {
      const value = args[++i];
      if (!value) throw new InitArgumentError('--name needs a value');
      initial.name = value;
      continue;
    }
    // `--force` is accepted and ignored: the wizard shows an existing file and
    // asks before replacing it, which is the same guard by other means.
    if (arg === '--force') continue;
    if (arg.startsWith('-')) throw new InitArgumentError(`unknown option '${arg}'`);
    if (target !== undefined) throw new InitArgumentError(`only one file can be written, got '${arg}' as well`);
    target = arg;
  }

  return { file: path.resolve(cwd, target ?? DEFAULT_INIT_FILE), initial };
}

/** Everything the wizard needs before its first question. */
export async function prepareInit(args: readonly string[], cwd: string): Promise<InitSession> {
  const { file, initial } = parseInitArgs(args.slice(1), cwd); // drop the `init` word
  return {
    file,
    fileName: path.basename(file),
    exists: existsSync(file),
    initial,
    context: await buildCatalogContext(),
  };
}

/** The wizard said yes: render, validate against the command tree, write. */
export function finishInit(session: InitSession, answers: Answers): Promise<WrittenPipeline> {
  return writePipelineDraft(answers, session.context, session.file, buildProgram());
}
