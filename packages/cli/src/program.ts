/**
 * The command tree, built in one place so more than the entry point can have it.
 *
 * `cli.tsx` parses argv with it; `pipeline init` resolves a generated file
 * against it before writing (the shell's in-process wizard included), which is
 * only possible because building it is separate from running it. Registration
 * has no side effects beyond defining commands, so building a second one costs
 * nothing.
 */
import { Command } from 'commander';
import { registerImportCommand } from './commands/import.js';
import { registerRenameCommand } from './commands/rename.js';
import { registerExifCommand } from './commands/exif.js';
import { registerCullCommand } from './commands/cull.js';
import { registerRateCommand } from './commands/rate.js';
import { registerTriageCommand } from './commands/triage.js';
import { registerEmbeddingsCommand } from './commands/embeddings.js';
import { registerMatchCommand } from './commands/match.js';
import { registerDevelopCommand } from './commands/develop.js';
import { registerPipelineCommand } from './commands/pipeline.js';
import { registerScheduleCommand } from './commands/schedule.js';
import { registerCacheCommand } from './commands/cache.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerReleaseNotesCommand } from './commands/release-notes.js';
import { VERSION } from './version.js';

/** Every shoots command, registered. `shell` is added by the entry point. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('shoots')
    .description(
      'Batch automation for photography workflows: import, rename, tag, cull, rate.\n' +
        'An orchestration layer for your pipeline — not an editor, not a DAM.\n\n' +
        'Run with no arguments to open the interactive shell.',
    )
    .version(VERSION);

  registerImportCommand(program);
  registerRenameCommand(program);
  registerExifCommand(program);
  registerCullCommand(program);
  registerRateCommand(program);
  registerTriageCommand(program);
  registerEmbeddingsCommand(program);
  registerMatchCommand(program);
  registerDevelopCommand(program);
  registerPipelineCommand(program);
  registerScheduleCommand(program);
  registerCacheCommand(program);
  registerSetupCommand(program);
  registerDoctorCommand(program);
  registerUpdateCommand(program);
  registerReleaseNotesCommand(program);

  return program;
}
