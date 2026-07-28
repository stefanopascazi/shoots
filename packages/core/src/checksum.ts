import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Canonicalize a pinned SHA-256 digest: strip an optional `sha256:` / `sha-256:`
 * algorithm prefix and surrounding whitespace, then lowercase. Manifests run
 * their pinned values through this so downstream validation (`/^[0-9a-f]{64}$/`)
 * and provisioning always see a bare hex digest, regardless of the format the
 * value was pasted in (a `sha256:`-prefixed digest is a common copy source).
 */
export function normalizeSha256(value: string): string {
  return value
    .trim()
    .replace(/^sha-?256:/i, '')
    .trim()
    .toLowerCase();
}

/** Streaming SHA-256 of a file, returned as a lowercase hex string. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
