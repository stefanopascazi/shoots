/**
 * Running a scheduler CLI (`crontab`, `schtasks`) and reading its answer.
 *
 * Both backends need the same three things: the exit code, the output, and the
 * ability to feed something to stdin (`crontab -` takes the whole new table
 * there). Nothing here uses a shell — the arguments are passed as an array so
 * that a path with a space in it is not a quoting puzzle.
 */
import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  command: string,
  args: readonly string[],
  stdin?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    // A missing scheduler binary is a real, reportable condition (a container
    // with no cron installed), not a crash — the caller turns it into advice.
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin, 'utf8');
  });
}
