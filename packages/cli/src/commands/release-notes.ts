/**
 * shoots release-notes [--all] [--json]
 *
 * What this release asks of you. Not a changelog — git-cliff already writes
 * that from the commits. This is the hand-written half: the steps a release
 * makes necessary, matched against what is actually stored in `~/.shoots`, so
 * the photographer learns about a breaking change *before* `develop predict`
 * refuses their profile rather than after.
 *
 * Exits 1 while a required step is outstanding, so `shoots release-notes ||
 * notify-me` works in a shell profile or a scheduled job.
 */
import type { Command } from 'commander';
import { makeIo, printHuman, printJson } from '../io.js';
import { VERSION } from '../version.js';
import { readArtifactStamps } from '../release-notes/artifacts.js';
import { MIGRATIONS } from '../release-notes/migrations.js';
import { outstandingMigrations, selectMigrations } from '../release-notes/select.js';
import { renderMigration, renderReport } from '../release-notes/render.js';

interface ReleaseNotesOptions {
  all?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export function registerReleaseNotesCommand(program: Command): void {
  program
    .command('release-notes')
    .description('Show the migration steps this release needs, checked against what is stored in ~/.shoots')
    .option('--all', 'show every migration note, not just the ones still outstanding')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runReleaseNotes);
}

async function runReleaseNotes(options: ReleaseNotesOptions): Promise<void> {
  const io = makeIo(options);
  const artifacts = await readArtifactStamps();
  const outstanding = outstandingMigrations(artifacts, VERSION);
  const required = outstanding.filter((o) => o.migration.required);

  if (io.json) {
    printJson({
      command: 'release-notes',
      version: VERSION,
      artifacts,
      outstanding: outstanding.map(({ migration, staleArtifacts }) => ({
        ...migration,
        staleArtifacts: staleArtifacts.map((a) => a.kind),
      })),
      requiredCount: required.length,
      ...(options.all ? { all: selectMigrations(null, VERSION) } : {}),
    });
  } else if (options.all) {
    printHuman(io, `\nshoots ${VERSION} — every migration note\n`);
    for (const migration of MIGRATIONS) {
      printHuman(io, '─'.repeat(78));
      for (const line of renderMigration(migration, [])) printHuman(io, line);
      printHuman(io, '');
    }
  } else {
    for (const line of renderReport(VERSION, outstanding, artifacts)) printHuman(io, line);
  }

  // A pending required step is a missing prerequisite, not a command failure —
  // but silence would defeat the purpose, so it is reported through the exit
  // code too. `--all` is a reference listing and never fails.
  if (required.length > 0 && !options.all) process.exitCode = 1;
}
