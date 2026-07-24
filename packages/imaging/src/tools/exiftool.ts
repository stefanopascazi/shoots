/**
 * exiftool provisioning and resolution.
 *
 * exiftool is not bundled with the shoots binary: it is downloaded on demand
 * into `~/.shoots/bin/exiftool/<version>/`, checksum-verified, and reused
 * forever after. `resolveExiftool()` is the cheap synchronous lookup used on
 * every exiftool call; `ensureExiftool()` performs the one-time download and is
 * called up-front by `shoots setup` and lazily by any command that needs it.
 */
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, extractTarGz } from '@shoots/core';
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

/** Written into the install dir once extraction has fully succeeded. */
const MARKER = '.shoots-ok';
const SHA256_RE = /^[0-9a-f]{64}$/;
const LOCK_STALE_MS = 5 * 60_000;

const override = (): string | undefined => {
  const v = process.env.SHOOTS_EXIFTOOL;
  return v && v.length > 0 ? v : undefined;
};

function commandFor(m: ResolvedExiftoolManifest): ExiftoolCommand {
  return m.viaPerl ? { command: 'perl', prefixArgs: [m.binPath] } : { command: m.binPath, prefixArgs: [] };
}

function isInstalled(m: ResolvedExiftoolManifest): boolean {
  return existsSync(path.join(m.installDir, MARKER)) && existsSync(m.binPath);
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
 * Idempotent, and safe against two first-run processes racing (dir lock).
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

  await withLock(m.installDir, async () => {
    if (isInstalled(m)) return; // another process won the race

    const parent = path.dirname(m.installDir);
    const base = path.basename(m.installDir);
    const staging = path.join(parent, `${base}.staging.${process.pid}`);
    const archive = path.join(parent, `${base}.download.${process.pid}.tar.gz`);
    await rm(staging, { recursive: true, force: true });

    try {
      options.onStatus?.(`downloading exiftool ${m.version}`);
      await downloadFile(m.url, archive, { sha256: m.sha256, onProgress: options.onProgress });
      options.onStatus?.('extracting');
      await extractTarGz(archive, staging);
      await writeFile(path.join(staging, MARKER), `${m.version}\n${m.sha256}\n`, 'utf8');
      // Atomically swap staging → final install dir.
      await rm(m.installDir, { recursive: true, force: true });
      await mkdir(parent, { recursive: true });
      await rename(staging, m.installDir);
    } finally {
      await rm(archive, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });

  if (!isInstalled(m)) throw new Error('exiftool provisioning did not complete');
  return commandFor(m);
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
        throw new Error(`Timed out waiting for tool lock: ${lockDir}`);
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
