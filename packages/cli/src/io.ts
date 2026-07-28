/**
 * Output conventions shared by all commands:
 * - stdout is reserved for the command's actual result (human table or --json)
 * - all logs / progress / warnings go to stderr, so JSON output stays pipeable
 * - exit code 0 = success, 1 = one or more failures, 2 = bad usage
 */

export interface CliIo {
  json: boolean;
  verbose: boolean;
}

export function makeIo(opts: { json?: boolean; verbose?: boolean }): CliIo {
  return { json: opts.json ?? false, verbose: opts.verbose ?? false };
}

/** Print the machine-readable result to stdout. */
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/** Human-facing result line (suppressed in --json mode to keep stdout clean). */
export function printHuman(io: CliIo, line: string): void {
  if (!io.json) process.stdout.write(line + '\n');
}

export function logWarn(message: string): void {
  process.stderr.write(`warn: ${message}\n`);
}

export function logError(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}

/**
 * Flatten a multi-line error into a single reportable line.
 *
 * libvips and exiftool accumulate every internal complaint into one message, so
 * a single unreadable file can emit dozens of lines — enough to bury the other
 * failures in a batch. The human report gets this collapsed form; `--json` keeps
 * the untouched `error` string for anyone who needs the full text.
 */
export function oneLine(message: string, max = 300): string {
  const flat = message.replace(/\s*\r?\n\s*/g, ' · ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function logVerbose(io: CliIo, message: string): void {
  if (io.verbose) process.stderr.write(`· ${message}\n`);
}

/** Mark the process as failed without aborting remaining cleanup. */
export function markFailure(): void {
  process.exitCode = 1;
}

export function parsePositiveInt(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
