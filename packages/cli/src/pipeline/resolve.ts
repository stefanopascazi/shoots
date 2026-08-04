/**
 * Turning a pipeline step into a shoots command line — and refusing to run one
 * that cannot work.
 *
 * The whole point of validating here rather than letting each step fail on its
 * own is time: a pipeline is `import → rate → cull → develop edit` over a card
 * full of RAWs, and a misspelt flag in the last step is otherwise discovered
 * forty minutes in, after the earlier steps have already written to disk. So the
 * commander tree — the actual, current definition of every command and every
 * flag — is walked up front, and every problem in the file is reported at once.
 *
 * Nothing here is command-specific. That is deliberate: a command added to
 * cli.tsx tomorrow is usable in a pipeline the same day, with no entry to add.
 */
import type { Command, Option } from 'commander';
import type { PipelineConfig, PipelineStep, PipelineValue } from '@shoots/core';

export interface ResolvedStep {
  step: PipelineStep;
  /** Position in the config's `steps` list, for error locations. */
  index: number;
  /** Arguments to hand this same build, e.g. `['develop','export','D:/x','--out','y']`. */
  argv: string[];
  /** The same thing, as a human would type it. */
  display: string;
  /** Set when the step will not run: why. `--from` adds its own reason later. */
  skip?: string;
}

export interface ResolveResult {
  steps: ResolvedStep[];
  issues: string[];
}

/** `writeXmp`, `--write-xmp` and `write-xmp` all name the same flag. */
function normalizeOptionKey(key: string): string {
  return key
    .replace(/^-+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** An option takes a value when it was declared with `<value>` or `[value]`. */
const takesValue = (option: Option): boolean => option.required || option.optional;

function quote(word: string): string {
  return /[\s"']/.test(word) ? `"${word.replace(/"/g, '\\"')}"` : word;
}

/**
 * Walk the commander tree to the command a step names, collecting a precise
 * error when the path does not lead anywhere runnable.
 */
function findCommand(program: Command, path: string[], where: string, issues: string[]): Command | null {
  let current: Command = program;
  const walked: string[] = [];

  for (const word of path) {
    const next = current.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (!next) {
      const available = current.commands
        .map((c) => c.name())
        .filter((n) => n !== 'help')
        .sort();
      const scope = walked.length > 0 ? `'${walked.join(' ')}' has no subcommand` : 'no such shoots command';
      issues.push(`${where}: ${scope} '${word}' (available: ${available.join(', ')})`);
      return null;
    }
    current = next;
    walked.push(word);
  }

  // A group command with no action of its own (`develop`, `match`) prints help
  // and fails when run bare — unless one of its subcommands is the default
  // (`triage` → `triage list`), which commander records on the parent.
  const subcommands = current.commands.filter((c) => c.name() !== 'help');
  const defaultName = (current as unknown as { _defaultCommandName?: string | null })._defaultCommandName;
  if (subcommands.length > 0) {
    // The default subcommand is what will actually run, so it — not the group —
    // owns the arguments and flags this step has to be checked against.
    const fallback = defaultName ? subcommands.find((c) => c.name() === defaultName) : undefined;
    if (!fallback) {
      issues.push(
        `${where}: '${walked.join(' ')}' needs a subcommand — one of: ${subcommands.map((c) => c.name()).sort().join(', ')}`,
      );
      return null;
    }
    return fallback;
  }
  return current;
}

/** Positional count against what the command declares. */
function checkArguments(cmd: Command, step: PipelineStep, where: string, issues: string[]): void {
  const declared = cmd.registeredArguments;
  const required = declared.filter((a) => a.required).length;
  const variadic = declared.some((a) => a.variadic);
  const given = step.args.length;

  const shape = declared.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(' ');

  if (given < required) {
    issues.push(
      `${where}: '${step.run}' needs ${required} positional argument(s) ${shape} — got ${given}. ` +
        `Positional arguments go in \`args:\`, not \`with:\`.`,
    );
    return;
  }
  if (!variadic && given > declared.length) {
    issues.push(
      `${where}: '${step.run}' takes at most ${declared.length} positional argument(s)${shape ? ` ${shape}` : ''} — got ${given}`,
    );
  }
}

/**
 * One `with:` entry → zero or more argv words.
 *
 * `false` on a plain boolean flag means "leave it off", which is why it emits
 * nothing rather than an error: a pipeline that spells out `move: false` is
 * documenting a decision, and that is worth encouraging.
 */
function appendOption(
  cmd: Command,
  key: string,
  value: PipelineValue,
  where: string,
  argv: string[],
  issues: string[],
): void {
  const name = normalizeOptionKey(key);
  const option =
    cmd.options.find((o) => o.long === `--${name}`) ?? cmd.options.find((o) => o.long === `--no-${name}`);

  if (!option) {
    const available = cmd.options
      .map((o) => o.long)
      .filter((l): l is string => Boolean(l))
      .sort();
    issues.push(`${where}: '${cmd.name()}' has no option '--${name}' (available: ${available.join(', ')})`);
    return;
  }

  const negated = cmd.options.find((o) => o.long === `--no-${name}`);

  if (typeof value === 'boolean') {
    if (takesValue(option)) {
      issues.push(`${where}: '--${name}' expects a value, got ${value}`);
      return;
    }
    if (value) {
      // `focus-rescue: true` where only `--no-focus-rescue` exists is the default.
      if (!option.negate) argv.push(option.long!);
    } else if (negated) {
      argv.push(negated.long!);
    } else if (option.negate) {
      argv.push(option.long!);
    }
    return;
  }

  if (!takesValue(option)) {
    issues.push(`${where}: '--${name}' is a flag — use true or false, not '${String(value)}'`);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return;
    if (option.variadic) {
      argv.push(option.long!, ...value.map(String));
    } else {
      // Every list-taking flag in shoots is comma-separated (`--set-keywords a,b`).
      argv.push(option.long!, value.map(String).join(','));
    }
    return;
  }

  argv.push(option.long!, String(value));
}

/**
 * Resolve every step against the commander tree.
 *
 * Disabled steps are passed through unresolved on purpose: parking a step that
 * names a command this build does not have yet is a legitimate way to keep a
 * pipeline file forward-compatible, and validating it would defeat that.
 */
export function resolvePipeline(program: Command, config: PipelineConfig): ResolveResult {
  const issues: string[] = [];
  const steps: ResolvedStep[] = [];

  config.steps.forEach((step, index) => {
    const where = `steps[${index}] (${step.id})`;
    if (!step.enabled) {
      steps.push({ step, index, argv: [], display: `shoots ${step.run}`, skip: 'disabled' });
      return;
    }

    const path = step.run.split(' ');
    const cmd = findCommand(program, path, where, issues);
    if (!cmd) {
      steps.push({ step, index, argv: [], display: `shoots ${step.run}` });
      return;
    }

    checkArguments(cmd, step, where, issues);

    const argv = [...path, ...step.args];

    // A default applies only where the command actually accepts it, so a global
    // `concurrency: 8` can sit at the top of a file whose steps do not all take it.
    const merged: Record<string, PipelineValue> = {};
    for (const [key, value] of Object.entries(config.defaults)) {
      const name = normalizeOptionKey(key);
      const known = cmd.options.some((o) => o.long === `--${name}` || o.long === `--no-${name}`);
      if (known) merged[key] = value;
    }
    Object.assign(merged, step.with);

    for (const [key, value] of Object.entries(merged)) {
      appendOption(cmd, key, value, where, argv, issues);
    }

    steps.push({ step, index, argv, display: `shoots ${argv.map(quote).join(' ')}` });
  });

  return { steps, issues };
}
