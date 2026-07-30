/**
 * Last-resort error reporting.
 *
 * Anything that escapes the CLI's own handling is reported by the runtime
 * itself: the standalone Bun executable prints a `Bun v1.x.y (Windows x64)`
 * banner and internal `B:/~BUN/root/...` paths. That is the wrong product name
 * on a shoots error report, so these handlers claim `uncaughtException` and
 * `unhandledRejection` first and print the failure in the project's `error: `
 * format instead (see io.ts for the output conventions).
 *
 * Stack traces are opt-in via SHOOTS_DEBUG=1: a batch user wants one readable
 * line, a bug report wants the trace.
 */
import { VERSION } from './version.js';

const ISSUES_URL = 'https://github.com/stefanopascazi/shoots/issues';

function report(kind: string, err: unknown): void {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  if (process.env.SHOOTS_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  const hint = process.env.SHOOTS_DEBUG ? '' : ' Re-run with SHOOTS_DEBUG=1 for the stack trace.';
  process.stderr.write(`\nshoots ${VERSION}: unexpected ${kind}.${hint} Report at ${ISSUES_URL}\n`);
  process.exit(1);
}

export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => report('error', err));
  process.on('unhandledRejection', (reason) => report('promise rejection', reason));
}
