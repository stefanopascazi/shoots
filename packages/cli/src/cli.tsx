/**
 * shoots — scriptable batch automation for photography workflows.
 * Entry point: command registration only; all logic lives in commands/*.
 *
 * `shoots` with no arguments on a TTY opens the interactive shell.
 */
import { Command } from 'commander';
import { registerImportCommand } from './commands/import.js';
import { registerRenameCommand } from './commands/rename.js';
import { registerExifCommand } from './commands/exif.js';
import { registerCullCommand } from './commands/cull.js';
import { registerRateCommand } from './commands/rate.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerUpdateCommand } from './commands/update.js';
import { VERSION } from './version.js';

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
registerSetupCommand(program);
registerDoctorCommand(program);
registerUpdateCommand(program);

program
  .command('shell')
  .description('Open the interactive shell (default when run with no arguments)')
  .action(launchShell);

async function launchShell(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write('error: the interactive shell needs a terminal (TTY). Run `shoots --help` for batch usage.\n');
    process.exitCode = 2;
    return;
  }
  const [{ render }, { Shell }, { createMouseWheel }] = await Promise.all([
    import('ink'),
    import('./shell/Shell.js'),
    import('./shell/mouse.js'),
  ]);

  // Enter the terminal's alternate screen buffer (the vim/less mechanism):
  // the shell takes over a clean fullscreen, and on exit the user's previous
  // terminal content is restored exactly as it was.
  let inAltScreen = false;
  const enterAltScreen = (): void => {
    process.stdout.write('\x1B[?1049h\x1B[2J\x1B[H');
    inAltScreen = true;
  };
  const leaveAltScreen = (): void => {
    if (inAltScreen) {
      process.stdout.write('\x1B[?1049l');
      inAltScreen = false;
    }
  };

  // Route the mouse wheel to scrollback (the alt buffer disables native scroll).
  const mouse = createMouseWheel(process.stdin);
  const cleanup = (): void => {
    mouse.disable();
    leaveAltScreen();
  };
  // Safety net: never leave the terminal stuck in the alt buffer or mouse mode.
  process.on('exit', cleanup);

  enterAltScreen();
  mouse.enable();
  const app = render(<Shell wheel={mouse.events} />, { stdin: mouse.stdin });
  await app.waitUntilExit();
  cleanup();
  process.stdout.write('◉ shoots — session closed. See you at the next shoot.\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    if (process.stdout.isTTY && process.stdin.isTTY) {
      await launchShell();
      return;
    }
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
