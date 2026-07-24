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
  // Pass a forward-slash `-C` path to tar. bsdtar (Windows System32) accepts
  // backslashes, but the GNU tar that ships with Git/MSYS does not — it mangles
  // `C:\...` and fails to open the directory. Forward slashes work for both,
  // and (unlike `-f`) `-C C:/...` is not misread as a remote host:path.
  const tarDest = process.platform === 'win32' ? destDir.replace(/\\/g, '/') : destDir;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', '-', '-C', tarDest], { stdio: ['pipe', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ArchiveError(`tar exited with code ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
    });
    // tar may close its stdin the moment it reaches the tar end-of-archive
    // marker — before the gzip stream's trailing bytes are written. That makes
    // the final write to the pipe fail with EPIPE; without a handler the
    // unhandled 'error' event would crash the process even though extraction
    // succeeded. Swallow EPIPE (the exit code is the source of truth) and
    // surface any other stdin error.
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') reject(e);
    });
    createReadStream(archivePath)
      .on('error', reject)
      .pipe(child.stdin);
  });
}
