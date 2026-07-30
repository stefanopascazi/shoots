/**
 * Re-invoking this same shoots build.
 *
 * Two callers need it, and they need it for different lifetimes: the interactive
 * shell spawns commands as children right now, while `schedule install` has to
 * hand the operating system a command line that still works in six months with
 * no shell, no PATH and no working directory to lean on.
 *
 * Both hinge on the same distinction. A Bun-compiled standalone binary *is* the
 * entry point — it must be re-run as `execPath <args>`, because Bun injects its
 * own argv[0]/argv[1] and a script path passed here would surface as a bogus
 * leading argument that commander reads as the command name. Under a bare
 * interpreter the entry is a script the interpreter has to be pointed at.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether we're running as a Bun-compiled standalone executable (the shipped
 * binary) rather than under a bare interpreter (node dist/cli.js in dev).
 * In a standalone binary `Bun.main` points inside Bun's virtual filesystem
 * ($bunfs / ~BUN), whereas under an interpreter it's a real file path.
 */
export function isStandaloneBinary(): boolean {
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  const main = bun?.main;
  return typeof main === 'string' && (main.includes('~BUN') || main.includes('$bunfs'));
}

/** The bundled entry, which lives next to this chunk in dist/. */
export function cliEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
}

/** The argv to re-invoke this build as a child process. */
export function selfArgv(args: readonly string[]): string[] {
  return isStandaloneBinary() ? [...args] : [cliEntryPath(), ...args];
}

/** An absolute, self-contained way to run this build. */
export interface Invocation {
  command: string;
  args: string[];
}

/**
 * How something outside this process — a cron daemon, the Windows Task
 * Scheduler — should invoke us. Absolute on both sides: nothing here may depend
 * on PATH or on the current directory.
 */
export function selfInvocation(args: readonly string[]): Invocation {
  return { command: process.execPath, args: selfArgv(args) };
}
