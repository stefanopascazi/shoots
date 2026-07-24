/**
 * Streamed, checksum-verified file download.
 *
 * External binaries are fetched over HTTPS from our own release mirror, so
 * every download MUST be pinned to an expected SHA-256 and verified before the
 * file is used — this is the supply-chain guard for a commercial product.
 * The body is streamed straight to a temp file while the hash is computed on
 * the fly; only after the digest matches is the file atomically renamed into
 * place. A mismatch (or any transport error) leaves no partial artifact behind.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class DownloadError extends Error {}
export class ChecksumError extends DownloadError {}

export interface DownloadOptions {
  /** Expected lowercase hex SHA-256 digest of the file. Required. */
  sha256: string;
  /** Progress callback; `total` is null when the server omits Content-Length. */
  onProgress?: (received: number, total: number | null) => void;
  signal?: AbortSignal;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export async function downloadFile(
  url: string,
  destPath: string,
  options: DownloadOptions,
): Promise<void> {
  const expected = options.sha256.trim().toLowerCase();
  if (!SHA256_RE.test(expected)) {
    throw new DownloadError(`Refusing to download ${url}: a valid sha256 must be provided`);
  }

  const res = await fetch(url, { redirect: 'follow', signal: options.signal });
  if (!res.ok || !res.body) {
    throw new DownloadError(`Download failed (${res.status} ${res.statusText}): ${url}`);
  }

  const total = Number(res.headers.get('content-length')) || null;
  await mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.${process.pid}.tmp`;

  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      options.onProgress?.(received, total);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(tmp),
    );
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  const digest = hash.digest('hex');
  if (digest !== expected) {
    await rm(tmp, { force: true });
    throw new ChecksumError(
      `Checksum mismatch for ${url}\n  expected ${expected}\n  got      ${digest}`,
    );
  }

  await rename(tmp, destPath);
}
