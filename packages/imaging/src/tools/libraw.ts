/**
 * LibRaw (`dcraw_emu`) provisioning and resolution.
 *
 * Mirrors the exiftool machinery: the binary is not bundled — it is downloaded
 * on demand into `~/.shoots/bin/libraw/<version>/`, checksum-verified, and reused
 * forever after. `resolveLibraw()` is the cheap synchronous lookup;
 * `ensureLibraw()` performs the one-time download (called up-front by
 * `shoots setup` and lazily by `develop export --baseline external`).
 *
 * `SHOOTS_LIBRAW` overrides everything with a path to a locally installed
 * dcraw_emu (validate the lever without the mirror, or use a system LibRaw).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { provisionArchive, PROVISION_MARKER } from '@shoots/core';
import { librawManifest, type ResolvedLibrawManifest } from './librawManifest.js';

/** Raised when the LibRaw mirror has no pinned checksum yet (dev/pre-release). */
export class LibrawMirrorNotConfiguredError extends Error {}

const SHA256_RE = /^[0-9a-f]{64}$/;

const override = (): string | undefined => {
  const v = process.env.SHOOTS_LIBRAW;
  return v && v.length > 0 ? v : undefined;
};

function isInstalled(m: ResolvedLibrawManifest): boolean {
  return existsSync(path.join(m.installDir, PROVISION_MARKER)) && existsSync(m.binPath);
}

/**
 * Synchronous, hot-path resolution. Never touches the network. Returns the
 * runnable dcraw_emu path, or null when LibRaw still needs to be provisioned.
 */
export function resolveLibraw(): string | null {
  const o = override();
  if (o) return o;
  try {
    const m = librawManifest();
    if (isInstalled(m)) return m.binPath;
  } catch {
    // unsupported platform — caller surfaces a clear error
  }
  return null;
}

export interface EnsureLibrawOptions {
  onStatus?: (message: string) => void;
  onProgress?: (received: number, total: number | null) => void;
}

/**
 * Provision LibRaw if missing: download → verify sha256 → extract → mark.
 * Idempotent and race-safe. Throws {@link LibrawMirrorNotConfiguredError} when
 * the mirror checksum is not pinned yet, so callers can treat it as a soft,
 * expected state during development.
 */
export async function ensureLibraw(options: EnsureLibrawOptions = {}): Promise<string> {
  const o = override();
  if (o) return o;

  const m = librawManifest();
  if (isInstalled(m)) return m.binPath;

  if (!SHA256_RE.test(m.sha256)) {
    throw new LibrawMirrorNotConfiguredError(
      `LibRaw ${m.version} has no pinned checksum yet. Build and upload the libraw ` +
        `mirror (scripts/prepare-libraw-mirror.ts / .github/workflows/libraw-mirror.yml), ` +
        `then fill sha256 in librawManifest.ts.`,
    );
  }

  await provisionArchive({
    installDir: m.installDir,
    url: m.url,
    sha256: m.sha256,
    label: `LibRaw ${m.version}`,
    markerContent: `${m.version}\n${m.sha256}\n`,
    onStatus: options.onStatus,
    onProgress: options.onProgress,
  });

  if (!isInstalled(m)) throw new Error('LibRaw provisioning did not complete');
  return m.binPath;
}
