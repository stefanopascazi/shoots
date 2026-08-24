/**
 * Draft → YAML text.
 *
 * Written by hand rather than through `yaml`'s document API because the point of
 * a generated pipeline is that a human opens it next: key order, blank lines
 * between steps and the comments that say what each variable is for are the
 * output, not decoration. Individual scalars still go through `yaml.stringify`,
 * so quoting stays the library's problem.
 */
import { stringify } from 'yaml';
import { PIPELINE_VERSION, type PipelineValue } from '../PipelineConfig.js';
import type { DraftStep, PipelineDraft } from './draft.js';

/** One scalar, quoted exactly as YAML needs it (and never with a trailing newline). */
function scalar(value: string | number | boolean): string {
  return stringify(value).replace(/\n$/, '');
}

/** Lists stay on one line: `[wedding, smith, "2026"]` reads better in a config. */
function renderValue(value: PipelineValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => scalar(item)).join(', ')}]`;
  return scalar(value);
}

function renderMapping(entries: Record<string, PipelineValue>, indent: string): string[] {
  return Object.entries(entries).map(([key, value]) => `${indent}${key}: ${renderValue(value)}`);
}

function renderStep(step: DraftStep): string[] {
  const lines: string[] = [];
  if (step.comment) lines.push(`  # ${step.comment}`);
  lines.push(`  - id: ${scalar(step.id)}`);
  lines.push(`    run: ${scalar(step.run)}`);
  if (step.args.length === 1) lines.push(`    args: ${scalar(step.args[0]!)}`);
  else if (step.args.length > 1) {
    lines.push('    args:');
    for (const arg of step.args) lines.push(`      - ${scalar(arg)}`);
  }
  const options = Object.entries(step.with);
  if (options.length > 0) {
    lines.push('    with:');
    lines.push(...renderMapping(step.with, '      '));
  }
  for (const note of step.notes ?? []) lines.push(`    # ${note}`);
  return lines;
}

export interface SerializeOptions {
  /** Header comment lines, written above `version:` (without the leading `#`). */
  header?: string[];
}

/** Render a draft as the YAML `shoots pipeline` will load. */
export function renderPipelineYaml(draft: PipelineDraft, options: SerializeOptions = {}): string {
  const lines: string[] = [];

  for (const line of options.header ?? []) lines.push(line.length > 0 ? `# ${line}` : '#');
  if (lines.length > 0) lines.push('');

  lines.push(`version: ${PIPELINE_VERSION}`);
  if (draft.name) lines.push(`name: ${scalar(draft.name)}`);

  if (draft.vars.length > 0) {
    lines.push('');
    lines.push('# Declared once, referenced as ${name} everywhere below.');
    lines.push('# Override without editing the file: --var name=value');
    lines.push('vars:');
    for (const entry of draft.vars) {
      if (entry.comment) lines.push(`  # ${entry.comment}`);
      lines.push(`  ${entry.name}: ${scalar(entry.value)}`);
    }
  }

  if (Object.keys(draft.defaults).length > 0) {
    lines.push('');
    lines.push('# Applied to every step whose command accepts the flag; the others ignore it.');
    lines.push('defaults:');
    lines.push(...renderMapping(draft.defaults, '  '));
  }

  lines.push('');
  lines.push('steps:');
  draft.steps.forEach((step, index) => {
    if (index > 0) lines.push('');
    lines.push(...renderStep(step));
  });

  return `${lines.join('\n')}\n`;
}
