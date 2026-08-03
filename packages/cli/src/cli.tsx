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
import { registerTriageCommand } from './commands/triage.js';
import { registerEmbeddingsCommand } from './commands/embeddings.js';
import { registerMatchCommand } from './commands/match.js';
import { registerDevelopCommand } from './commands/develop.js';
import { registerScheduleCommand } from './commands/schedule.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerReleaseNotesCommand } from './commands/release-notes.js';
import { assertShellCatalogInSync } from './shell/catalog.js';
import { installCrashHandlers } from './crash.js';
import { VERSION } from './version.js';

// Before anything else: keep the runtime's own crash banner out of our output.
installCrashHandlers();

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
registerScheduleCommand(program);
registerSetupCommand(program);
registerDoctorCommand(program);
registerUpdateCommand(program);
registerReleaseNotesCommand(program);

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
    mouse.stop();
    leaveAltScreen();
  };
  // Safety net: never leave the terminal stuck in the alt buffer or mouse mode.
  process.on('exit', cleanup);

  enterAltScreen();
  mouse.start();
  const app = render(<Shell mouse={mouse} />, { stdin: mouse.stdin });
  await app.waitUntilExit();
  cleanup();
  process.stdout.write('◉ shoots — session closed. See you at the next shoot.\n');
}

/**
 * Resolve once stdout/stderr have flushed their buffers — or after `ms`,
 * whichever comes first.
 *
 * The deadline is not a nicety. By the time this runs the command has printed
 * everything it had to say, so a write callback that never fires (a pipe nobody
 * is draining, a runtime whose zero-length write takes a fast path) would hold
 * a finished CLI open forever, showing complete output and no prompt back.
 * Losing a few trailing bytes in that case is strictly better than not exiting.
 */
function flushStdio(ms = 2000): Promise<void> {
  return new Promise((resolve) => {
    let pending = 2;
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const done = (): void => {
      if (--pending <= 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    process.stdout.write('', done);
    process.stderr.write('', done);
  });
}

/**
 * What is still alive at exit, on request (`SHOOTS_DEBUG_EXIT=1`).
 *
 * `process.exit` below hides a leaked handle by design, which is right for a
 * one-shot CLI and useless when the report is "it never came back". This is how
 * that report gets evidence attached to it without a rebuild.
 */
function reportLiveHandles(): void {
  if (!process.env.SHOOTS_DEBUG_EXIT) return;
  const live = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : ['unavailable'];
  process.stderr.write(`· exiting ${process.exitCode ?? 0}; still alive: ${live.join(', ')}\n`);
}

async function main(): Promise<void> {
  // Fail loudly if a CLI command lacks its shell counterpart (see the
  // "every command lives in the shell" convention). Cheap set compare; runs on
  // every invocation so drift surfaces the moment any command is executed.
  assertShellCatalogInSync(program);

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
  // Batch commands use native addons (onnxruntime, sharp/libvips) and the Ink
  // progress view, whose thread pools / stdin handles can keep the event loop
  // alive after the work is finished. For a one-shot CLI the correct behavior is
  // to exit promptly once output is flushed — preserving the command's exit code.
  await flushStdio();
  reportLiveHandles();
  process.exit(process.exitCode ?? 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
