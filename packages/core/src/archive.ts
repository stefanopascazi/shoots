/**
 * Archive extraction via the system `tar`.
 *
 * We deliberately shell out to `tar` (bsdtar ships with Windows 10 1803+,
 * macOS and every Linux desktop) instead of adding a third-party unpacking
 * dependency. Tool mirror archives are always normalized to `.tar.gz` with the
 * runnable files at the archive root, so a single extractor covers every OS.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

export class ArchiveError extends Error {}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ArchiveError(`${cmd} exited with code ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
    });
  });
}

/** Extract a gzip-compressed tarball into `destDir` (created if missing). */
export async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await run('tar', ['-xzf', archivePath, '-C', destDir]);
}
