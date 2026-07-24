/**
 * Archive extraction via the system `tar`.
 *
 * We deliberately shell out to `tar` (bsdtar ships with Windows 10 1803+,
 * macOS and every Linux desktop) instead of adding a third-party unpacking
 * dependency. Tool mirror archives are always normalized to `.tar.gz` with the
 * runnable files at the archive root, so a single extractor covers every OS.
 *
 * The archive is streamed to tar over stdin (`-f -`) rather than passed as a
 * path argument: on Windows a drive-letter path like `C:\...` is otherwise
 * misread by GNU tar as a remote `host:path`. `-C <dir>` is not subject to that
 * interpretation, so the (also colon-bearing) destination is safe as an arg.
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';

export class ArchiveError extends Error {}

/** Extract a gzip-compressed tarball into `destDir` (created if missing). */
export async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', '-', '-C', destDir], { stdio: ['pipe', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ArchiveError(`tar exited with code ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
    });
    createReadStream(archivePath)
      .on('error', reject)
      .pipe(child.stdin);
  });
}
