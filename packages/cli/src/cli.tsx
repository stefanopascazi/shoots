/**
 * shoots — scriptable batch automation for photography workflows.
 * Entry point: command registration only; all logic lives in commands/*.
 */
import { Command } from 'commander';
import { registerImportCommand } from './commands/import.js';
import { registerRenameCommand } from './commands/rename.js';
import { registerExifCommand } from './commands/exif.js';
import { registerCullCommand } from './commands/cull.js';
import { registerRateCommand } from './commands/rate.js';

const program = new Command();

program
  .name('shoots')
  .description(
    'Batch automation for photography workflows: import, rename, tag, cull, rate.\n' +
      'An orchestration layer for your pipeline — not an editor, not a DAM.',
  )
  .version('0.1.0');

registerImportCommand(program);
registerRenameCommand(program);
registerExifCommand(program);
registerCullCommand(program);
registerRateCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
