/**
 * Renders `packages/cli/src/release-notes/migrations.ts` into `docs/migrations.md`.
 *
 * The notes are authored in TypeScript because the standalone binary ships no
 * `docs/` directory and `shoots release-notes` has to print them at runtime.
 * The doc is the published mirror of that same list, generated so the two can
 * never disagree.
 *
 *   bun scripts/generate-migrations-doc.ts            # write
 *   bun scripts/generate-migrations-doc.ts --check    # fail if stale (CI)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, type Migration } from '../packages/cli/src/release-notes/migrations.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repo, 'docs', 'migrations.md');

const HEADER = `# Migration notes

What each release asks of you — the steps that cannot be derived from a
changelog. \`shoots release-notes\` prints the entries below that still apply to
this machine, checked against the profile and dataset in \`~/.shoots\`.

> Generated from \`packages/cli/src/release-notes/migrations.ts\`. Do not edit by hand.

---
`;

function renderEntry(m: Migration): string {
  const lines: string[] = [];
  lines.push(`## ${m.version} — ${m.title}`);
  lines.push('');
  lines.push(`**Required:** ${m.required ? 'yes' : 'no'}  `);
  lines.push(`**Affects:** ${m.affects.join(', ')}`);
  lines.push('');
  lines.push(m.summary);
  if (m.steps.length > 0) {
    lines.push('');
    lines.push('### What to do');
    lines.push('');
    lines.push('```sh');
    for (const step of m.steps) lines.push(step);
    lines.push('```');
  }
  if (m.notes.length > 0) {
    lines.push('');
    for (const note of m.notes) lines.push(`- ${note}`);
  }
  lines.push('');
  return lines.join('\n');
}

function render(): string {
  const newestFirst = [...MIGRATIONS].reverse();
  return [HEADER, ...newestFirst.map(renderEntry)].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

const wanted = render();
const check = process.argv.includes('--check');
const current = await readFile(target, 'utf8').catch(() => null);

if (check) {
  if (current !== wanted) {
    console.error('[migrations-doc] docs/migrations.md is stale — run `bun scripts/generate-migrations-doc.ts`');
    process.exit(1);
  }
  console.log('[migrations-doc] docs/migrations.md is up to date');
} else {
  await writeFile(target, wanted, 'utf8');
  console.log(`[migrations-doc] wrote ${target} (${MIGRATIONS.length} entries)`);
}
