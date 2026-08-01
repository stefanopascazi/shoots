/**
 * Human rendering of the migration notes.
 *
 * The point of the command is that a required step cannot be skimmed past, so
 * the layout leads with the verdict, then the steps, then the reasoning — the
 * reverse of how the notes are authored.
 */
import type { Migration } from './migrations.js';
import type { ArtifactStamp } from './artifacts.js';
import type { OutstandingMigration } from './select.js';

const WIDTH = 78;

/** Wrap at word boundaries; long tokens (paths, URLs) are left intact. */
export function wrap(text: string, indent = '', width = WIDTH): string[] {
  const limit = Math.max(20, width - indent.length);
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= limit) current += ` ${word}`;
    else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== '') lines.push(indent + current);
  return lines;
}

const stamped = (s: ArtifactStamp): string => `${s.kind} (built by ${s.version ?? '0.4.8 or earlier'})`;

export function renderMigration(migration: Migration, stale: ArtifactStamp[]): string[] {
  const out: string[] = [];
  out.push(`${migration.version} — ${migration.title}`);
  out.push(migration.required ? '  ACTION REQUIRED' : '  informational');
  if (stale.length > 0) out.push(`  affects: ${stale.map(stamped).join(', ')}`);
  out.push('');
  out.push(...wrap(migration.summary, '  '));
  if (migration.steps.length > 0) {
    out.push('');
    out.push('  Do this:');
    for (const step of migration.steps) out.push(`    $ ${step}`);
  }
  for (const note of migration.notes) {
    out.push('');
    const [first, ...rest] = wrap(note, '    ');
    out.push(`  · ${first.trimStart()}`);
    out.push(...rest);
  }
  return out;
}

export function renderReport(
  running: string,
  outstanding: OutstandingMigration[],
  artifacts: ArtifactStamp[],
): string[] {
  const out: string[] = [`\nshoots ${running} — release notes\n`];

  if (artifacts.length === 0) {
    out.push('No develop profile or dataset on this machine yet — nothing to migrate.');
    out.push('Start with `shoots develop init <your-edited-catalog>`.\n');
    return out;
  }

  for (const artifact of artifacts) {
    out.push(`  ${artifact.kind.padEnd(8)} built by ${artifact.version ?? '0.4.8 or earlier'}  ${artifact.path}`);
  }
  out.push('');

  if (outstanding.length === 0) {
    out.push('Everything on this machine matches this build. Nothing to do.\n');
    return out;
  }

  const required = outstanding.filter((o) => o.migration.required);
  out.push(
    required.length > 0
      ? `⚠ ${required.length === 1 ? 'A required step is' : `${required.length} required steps are`} outstanding — ` +
        `the develop predictor will refuse to run until ${required.length === 1 ? 'it is' : 'they are'} done.`
      : `${outstanding.length} note${outstanding.length === 1 ? '' : 's'} since these were built.`,
  );
  out.push('');

  for (const { migration, staleArtifacts } of outstanding) {
    out.push('─'.repeat(WIDTH));
    out.push(...renderMigration(migration, staleArtifacts));
    out.push('');
  }

  if (required.length > 0) {
    out.push('─'.repeat(WIDTH));
    out.push('Run the steps above, in order, before your next shoot.\n');
  }
  return out;
}
