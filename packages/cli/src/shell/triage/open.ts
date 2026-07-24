/**
 * Open a file in the OS default application, detached and non-blocking, so the
 * review overlay can flash a full-size preview without leaving the shell.
 */
import { spawn } from 'node:child_process';

export function openInSystemViewer(file: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'win32'
      ? ['cmd', ['/c', 'start', '', file]]
      : platform === 'darwin'
        ? ['open', [file]]
        : ['xdg-open', [file]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* viewer unavailable — nothing to do from a TUI */
    });
    child.unref();
  } catch {
    // best-effort preview; never crash the shell
  }
}
