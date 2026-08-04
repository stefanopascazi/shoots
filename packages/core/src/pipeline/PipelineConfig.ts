/**
 * Declarative pipeline configuration for `shoots pipeline <config.yaml>`.
 *
 * A pipeline is a list of shoots commands, in order, with their arguments —
 * nothing more. The step schema is deliberately *generic* (`run` + `args` +
 * `with`) rather than one typed shape per command: a photographer's pipeline is
 * `import → rename → exif → rate → cull → develop edit` today and `develop
 * export → train` tomorrow, and a schema that enumerates commands can only ever
 * describe the ones somebody remembered to add. Mapping `with:` onto the
 * command's own flags means every command — and every flag it grows later — is
 * available the day it ships. The CLI validates the mapping against commander's
 * real definitions before anything runs, so a typo is a load error, not a
 * failure twenty minutes into the run.
 *
 * `vars` exist for the other half of the problem: the same shoot folder is the
 * argument to exif, rate, cull and develop, and repeating it four times is how
 * three of them end up pointing somewhere slightly different.
 *
 * This module stays pure: it parses, interpolates and structurally validates.
 * It knows nothing about which commands exist — that lives in the CLI, which is
 * where the answer actually is.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

/** Scalars a step may pass to a flag, plus lists for repeatable/CSV flags. */
export type PipelineValue = string | number | boolean | Array<string | number>;

export interface PipelineConfig {
  /** Config schema version. Currently always 2. */
  version: 2;
  /** Optional human-readable pipeline name. */
  name?: string;
  /** Values referenced as `${key}` anywhere in the file. Always present (possibly empty). */
  vars: Record<string, string>;
  /** Flags applied to every step whose command accepts them. */
  defaults: Record<string, PipelineValue>;
  steps: PipelineStep[];
}

/** A step, normalized: every optional field is filled in by the parser. */
export interface PipelineStep {
  /** Stable identifier, for logs and `--from`. Defaults to the command path. */
  id: string;
  /** The shoots command to run, subcommands space-separated (`develop export`). */
  run: string;
  /** Positional arguments, in order. */
  args: string[];
  /** Options, by their long-flag name (`write-xmp` or `writeXmp` — both work). */
  with: Record<string, PipelineValue>;
  /** Set false to skip without deleting the step. */
  enabled: boolean;
  /** Keep going when this step fails, instead of stopping the pipeline. */
  continueOnError: boolean;
}

/**
 * A config that cannot be run, with every problem found rather than the first.
 *
 * A pipeline is a file somebody is editing, so reporting one error per attempt
 * turns a fixable config into a guessing game.
 */
export class PipelineConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string | string[]) {
    const list = typeof issues === 'string' ? [issues] : issues;
    super(list.join('\n'));
    this.name = 'PipelineConfigError';
    this.issues = list;
  }
}

/** The generic-step schema. Version 1 was the typed-step draft; see below. */
export const PIPELINE_VERSION = 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Resolve `${name}` references against the vars, and `${env:NAME}` against the
 * environment. `$${...}` is a literal — filename templates use single braces
 * (`{date}`) so the two languages do not collide, but a shell-ish `${}` in a
 * caption should still be expressible.
 */
function interpolate(text: string, vars: Record<string, string>, where: string, issues: string[]): string {
  return text.replace(/\$(\$)?\{([^}]*)\}/g, (_match, escaped: string | undefined, key: string) => {
    if (escaped) return `\${${key}}`;
    const name = key.trim();
    if (name.startsWith('env:')) {
      const envName = name.slice(4).trim();
      const value = process.env[envName];
      if (value === undefined) {
        issues.push(`${where}: environment variable '${envName}' is not set`);
        return '';
      }
      return value;
    }
    if (!(name in vars)) {
      const known = Object.keys(vars);
      issues.push(
        `${where}: unknown variable '${name}'` + (known.length > 0 ? ` (defined: ${known.join(', ')})` : ' (no vars defined)'),
      );
      return '';
    }
    return vars[name]!;
  });
}

/** YAML scalars all reach the command line as text; lists keep their shape. */
function coerceValue(value: unknown, where: string, issues: string[]): PipelineValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items: Array<string | number> = [];
    for (const [i, item] of value.entries()) {
      if (typeof item === 'string' || typeof item === 'number') items.push(item);
      else issues.push(`${where}[${i}] must be a string or a number`);
    }
    return items;
  }
  issues.push(`${where} must be a string, number, boolean or list`);
  return undefined;
}

function interpolateValue(
  value: PipelineValue,
  vars: Record<string, string>,
  where: string,
  issues: string[],
): PipelineValue {
  if (typeof value === 'string') return interpolate(value, vars, where, issues);
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? interpolate(item, vars, where, issues) : item));
  }
  return value;
}

/**
 * `vars`, resolved in declaration order so a var may build on the ones above it
 * (`raw: ${shoot}/raw`). Overrides from `--var` are seeded first and win: they
 * replace the file's value rather than being shadowed by it, which is the only
 * reading that makes `--var shoot=...` useful.
 */
function resolveVars(
  raw: unknown,
  overrides: Record<string, string>,
  issues: string[],
): Record<string, string> {
  const vars: Record<string, string> = { ...overrides };
  if (raw === undefined || raw === null) return vars;
  if (!isRecord(raw)) {
    issues.push('`vars` must be a mapping of name → value');
    return vars;
  }

  for (const [name, value] of Object.entries(raw)) {
    if (name in overrides) continue; // --var wins
    if (value === null || value === undefined) {
      issues.push(`vars.${name} has no value`);
      continue;
    }
    if (typeof value === 'object') {
      issues.push(`vars.${name} must be a string, number or boolean`);
      continue;
    }
    vars[name] = interpolate(String(value), vars, `vars.${name}`, issues);
  }
  return vars;
}

function parseWith(
  raw: unknown,
  vars: Record<string, string>,
  where: string,
  issues: string[],
): Record<string, PipelineValue> {
  const out: Record<string, PipelineValue> = {};
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    issues.push(`${where} must be a mapping of option → value`);
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    const coerced = coerceValue(value, `${where}.${key}`, issues);
    if (coerced === undefined) continue;
    out[key] = interpolateValue(coerced, vars, `${where}.${key}`, issues);
  }
  return out;
}

function parseArgs(raw: unknown, vars: Record<string, string>, where: string, issues: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const [i, item] of list.entries()) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      issues.push(`${where}[${i}] must be a string or a number`);
      continue;
    }
    out.push(interpolate(String(item), vars, `${where}[${i}]`, issues));
  }
  return out;
}

export interface ParseOptions {
  /** `--var name=value` overrides, applied before the file's own vars. */
  vars?: Record<string, string>;
}

/** Parse, interpolate and structurally validate a pipeline config from YAML text. */
export function parsePipelineConfig(yamlText: string, options: ParseOptions = {}): PipelineConfig {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    throw new PipelineConfigError(`not valid YAML — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(doc)) throw new PipelineConfigError('a pipeline config must be a YAML mapping');

  // Version 1 was the typed-step draft (`type: import` with per-command fields).
  // It was documented as authorable but never executable, and its steps carried
  // no paths — they assumed a file set flowing between handlers, which the
  // command-per-step model does not have. There is no faithful translation, so
  // say so plainly instead of half-running it.
  if (doc.version === 1) {
    throw new PipelineConfigError(
      'pipeline version 1 (typed `type:` steps) was never executable and has been replaced by version 2 ' +
        '(`run:` + `args:` + `with:`). See docs/pipelines.md for the migration — it is mechanical.',
    );
  }
  if (doc.version !== PIPELINE_VERSION) {
    throw new PipelineConfigError(
      `unsupported pipeline version: ${String(doc.version)} (expected ${PIPELINE_VERSION})`,
    );
  }

  const issues: string[] = [];
  const vars = resolveVars(doc.vars, options.vars ?? {}, issues);
  const defaults = parseWith(doc.defaults, vars, 'defaults', issues);

  if (doc.name !== undefined && typeof doc.name !== 'string') issues.push('`name` must be a string');

  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    issues.push('a pipeline must declare a non-empty `steps` list');
    throw new PipelineConfigError(issues);
  }

  const steps: PipelineStep[] = [];
  const seenIds = new Set<string>();

  doc.steps.forEach((raw: unknown, i: number) => {
    const where = `steps[${i}]`;
    if (!isRecord(raw)) {
      issues.push(`${where} must be a mapping`);
      return;
    }
    if ('type' in raw && !('run' in raw)) {
      issues.push(`${where} uses the version 1 \`type:\` form — write \`run: ${String(raw.type)}\` instead`);
      return;
    }
    if (typeof raw.run !== 'string' || raw.run.trim().length === 0) {
      issues.push(`${where}.run must name a shoots command (e.g. \`run: rate\` or \`run: develop export\`)`);
      return;
    }

    const run = interpolate(raw.run, vars, `${where}.run`, issues).trim().replace(/\s+/g, ' ');
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : run;
    if (seenIds.has(id)) issues.push(`${where}.id '${id}' is already used — ids must be unique`);
    seenIds.add(id);

    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      issues.push(`${where}.enabled must be true or false`);
    }
    const continueOnError = raw['continue-on-error'] ?? raw.continueOnError;
    if (continueOnError !== undefined && typeof continueOnError !== 'boolean') {
      issues.push(`${where}.continue-on-error must be true or false`);
    }

    steps.push({
      id,
      run,
      args: parseArgs(raw.args, vars, `${where}.args`, issues),
      with: parseWith(raw.with, vars, `${where}.with`, issues),
      enabled: raw.enabled !== false,
      continueOnError: continueOnError === true,
    });
  });

  if (issues.length > 0) throw new PipelineConfigError(issues);

  return {
    version: PIPELINE_VERSION,
    name: typeof doc.name === 'string' ? doc.name : undefined,
    vars,
    defaults,
    steps,
  };
}

export async function loadPipelineConfig(filePath: string, options: ParseOptions = {}): Promise<PipelineConfig> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new PipelineConfigError(`cannot read pipeline config: ${filePath}`);
  }
  return parsePipelineConfig(text, options);
}

/** Parse `name=value` pairs from repeated `--var` flags. */
export function parseVarOverrides(pairs: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  const bad: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      bad.push(pair);
      continue;
    }
    vars[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  if (bad.length > 0) throw new PipelineConfigError(bad.map((p) => `--var '${p}' must be name=value`));
  return vars;
}
