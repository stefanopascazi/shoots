/**
 * exiftool provisioning and resolution.
 *
 * exiftool is not bundled with the shoots binary: it is downloaded on demand
 * into `~/.shoots/bin/exiftool/<version>/`, checksum-verified, and reused
 * forever after. `resolveExiftool()` is the cheap synchronous lookup used on
 * every exiftool call; `ensureExiftool()` performs the one-time download and is
 * called up-front by `shoots setup` and lazily by any command that needs it.
 *
 * The generic download → verify → extract → mark machinery (locking, staging,
 * atomic swap) lives in `@shoots/core`'s `provisionArchive`; this module only
 * resolves the per-platform manifest and knows how to run the result.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { provisionArchive, PROVISION_MARKER } from '@shoots/core';
import {
  exiftoolManifest,
  type ResolvedExiftoolManifest,
} from './exiftoolManifest.js';

export interface ExiftoolCommand {
  /** Executable to spawn. */
  command: string;
  /** Arguments inserted before the caller's own args (e.g. the exiftool script
   *  path when invoked through Perl). */
  prefixArgs: string[];
}

export class ToolMirrorNotConfiguredError extends Error {}

const SHA256_RE = /^[0-9a-f]{64}$/;

const override = (): string | undefined => {
  const v = process.env.SHOOTS_EXIFTOOL;
  return v && v.length > 0 ? v : undefined;
};

function commandFor(m: ResolvedExiftoolManifest): ExiftoolCommand {
  return m.viaPerl ? { command: 'perl', prefixArgs: [m.binPath] } : { command: m.binPath, prefixArgs: [] };
}

function isInstalled(m: ResolvedExiftoolManifest): boolean {
  return existsSync(path.join(m.installDir, PROVISION_MARKER)) && existsSync(m.binPath);
}

/**
 * Synchronous, hot-path resolution used per exiftool invocation. Never touches
 * the network. Returns null when exiftool still needs to be provisioned.
 */
export function resolveExiftool(): ExiftoolCommand | null {
  const o = override();
  if (o) return { command: o, prefixArgs: [] };
  try {
    const m = exiftoolManifest();
    if (isInstalled(m)) return commandFor(m);
  } catch {
    // unsupported platform — caller will surface a clear error
  }
  return null;
}

export interface EnsureExiftoolOptions {
  onStatus?: (message: string) => void;
  onProgress?: (received: number, total: number | null) => void;
}

/**
 * Provision exiftool if missing: download → verify sha256 → extract → mark.
 * Idempotent, and safe against two first-run processes racing.
 */
export async function ensureExiftool(options: EnsureExiftoolOptions = {}): Promise<ExiftoolCommand> {
  const o = override();
  if (o) return { command: o, prefixArgs: [] };

  const m = exiftoolManifest();
  if (isInstalled(m)) return commandFor(m);

  if (!SHA256_RE.test(m.sha256)) {
    throw new ToolMirrorNotConfiguredError(
      `exiftool ${m.version} has no pinned checksum yet. Build and upload the tool ` +
        `mirror, then fill sha256 in exiftoolManifest.ts (see scripts/prepare-tool-mirror.ts).`,
    );
  }

  await provisionArchive({
    installDir: m.installDir,
    url: m.url,
    sha256: m.sha256,
    label: `exiftool ${m.version}`,
    markerContent: `${m.version}\n${m.sha256}\n`,
    onStatus: options.onStatus,
    onProgress: options.onProgress,
  });

  // provisionArchive verified its own marker; this also checks the binary path.
  if (!isInstalled(m)) throw new Error('exiftool provisioning did not complete');
  return commandFor(m);
}
