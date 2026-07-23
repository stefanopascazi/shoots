/**
 * Executes a shoots CLI command as a child process and streams its output
 * line-by-line into the shell UI. Running out-of-process keeps the command
 * implementations 100% unchanged and guarantees the child sees a non-TTY
 * stdout (so its own Ink progress view never activates).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type OutputStream = 'out' | 'err';

export interface RunningCommand {
  /** Resolves with the child's exit code (1 on spawn failure). */
  wait: Promise<number>;
  kill: () => void;
}

/** The bundled entry lives next to this chunk in dist/. */
function cliEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
}

export function runCli(
  args: string[],
  cwd: string,
  onLine: (text: string, stream: OutputStream) => void,
): RunningCommand {
  const child = spawn(process.execPath, [cliEntryPath(), ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const readLines = (stream: NodeJS.ReadableStream, tag: OutputStream): void => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, newline).replace(/\r$/, ''), tag);
        buffer = buffer.slice(newline + 1);
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) onLine(buffer, tag);
    });
  };

  readLines(child.stdout, 'out');
  readLines(child.stderr, 'err');

  const wait = new Promise<number>((resolve) => {
    child.on('error', (err) => {
      onLine(`failed to launch: ${err.message}`, 'err');
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });

  return { wait, kill: () => child.kill() };
}
