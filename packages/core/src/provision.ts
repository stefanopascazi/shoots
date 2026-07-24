/**
 * Generic "download → verify → extract → mark" provisioning for a versioned
 * install directory, shared by every runtime-provisioned dependency (exiftool
 * binaries, ONNX model weights, ...).
 *
 * The contract mirrors what exiftool needed and factors out the delicate parts
 * so callers never reimplement them: a cross-process directory lock (so two
 * first-run processes don't race), staging + atomic swap (so a half-extracted
 * install is never visible), and a success marker written last (so presence of
 * the marker means the install is complete and checksum-verified).
 *
 * Callers supply a resolved {installDir, url, sha256}; anything dependency-
 * specific (platform manifest resolution, how to run the result) stays with the
 * caller.
 */
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { downloadFile } from './net/download.js';
import { extractTarGz } from './archive.js';

/** Written into the install dir once extraction has fully succeeded. */
export const PROVISION_MARKER = '.shoots-ok';

const SHA256_RE = /^[0-9a-f]{64}$/;
const LOCK_STALE_MS = 5 * 60_000;

export interface ProvisionArchiveOptions {
  /** Final directory the archive is installed into (created atomically). */
  installDir: string;
  /** URL of the normalized `.tar.gz` (an `http(s):` mirror or a `file:` URL). */
  url: string;
  /** Expected lowercase hex SHA-256 of the archive. Verified before extraction. */
  sha256: string;
  /** Marker file name written into installDir on success. */
  marker?: string;
  /** Marker file contents (provenance). Defaults to the pinned sha256. */
  markerContent?: string;
  /** Human label for status lines, e.g. "exiftool 13.59" or "clip-vit-b32". */
  label?: string;
  onStatus?: (message: string) => void;
  onProgress?: (received: number, total: number | null) => void;
}

/** True once a provisioning has completed (its marker is present). */
export function isProvisioned(installDir: string, marker: string = PROVISION_MARKER): boolean {
  return existsSync(path.join(installDir, marker));
}

/**
 * Provision `installDir` from `url` if not already present. Idempotent, and
 * safe against two first-run processes racing (directory lock). Throws on a
 * checksum mismatch, transport error, or a missing/invalid sha256 — leaving no
 * partial install behind.
 */
export async function provisionArchive(options: ProvisionArchiveOptions): Promise<void> {
  const { installDir, url, sha256 } = options;
  const marker = options.marker ?? PROVISION_MARKER;
  const label = options.label ?? path.basename(installDir);

  if (isProvisioned(installDir, marker)) return;

  const expected = sha256.trim().toLowerCase();
  if (!SHA256_RE.test(expected)) {
    throw new Error(`Refusing to provision ${label}: a valid pinned sha256 is required`);
  }

  await withLock(installDir, async () => {
    if (isProvisioned(installDir, marker)) return; // another process won the race

    const parent = path.dirname(installDir);
    const base = path.basename(installDir);
    const staging = path.join(parent, `${base}.staging.${process.pid}`);
    const archive = path.join(parent, `${base}.download.${process.pid}.tar.gz`);
    await rm(staging, { recursive: true, force: true });

    try {
      options.onStatus?.(`downloading ${label}`);
      await downloadFile(url, archive, { sha256: expected, onProgress: options.onProgress });
      options.onStatus?.('extracting');
      await extractTarGz(archive, staging);
      await writeFile(path.join(staging, marker), options.markerContent ?? `${expected}\n`, 'utf8');
      // Atomically swap staging → final install dir.
      await rm(installDir, { recursive: true, force: true });
      await mkdir(parent, { recursive: true });
      await rename(staging, installDir);
    } finally {
      await rm(archive, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  if (!isProvisioned(installDir, marker)) {
    throw new Error(`${label} provisioning did not complete`);
  }
}

/** Cross-process lock via atomic mkdir; recovers stale locks by age. */
async function withLock<T>(installDir: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${installDir}.lock`;
  await mkdir(path.dirname(lockDir), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir); // fails if it already exists
      break;
    } catch {
      try {
        const age = Date.now() - (await stat(lockDir)).mtimeMs;
        if (age > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished — retry acquiring
      }
      if (Date.now() - start > LOCK_STALE_MS) {
        throw new Error(`Timed out waiting for provisioning lock: ${lockDir}`);
      }
      await delay(300);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
