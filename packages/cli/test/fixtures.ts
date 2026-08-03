/**
 * Disposable catalogs for the end-to-end tests.
 *
 * Every test gets its own SHOOTS_HOME and its own tree, because the triage store
 * is machine-global by design: a test that inherited the developer's real
 * ~/.shoots would both read their marks and write into them.
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

/**
 * An exiftool this machine already has, for the sandbox to borrow.
 *
 * A fresh SHOOTS_HOME has no tools in it, and left to itself the CLI would
 * download one — a test suite that reaches the network to run is a test suite
 * that fails on a plane. Borrowing the developer's own provisioned copy through
 * SHOOTS_EXIFTOOL keeps the sandbox otherwise pristine.
 */
export function findExiftool(): string | undefined {
  if (process.env.SHOOTS_EXIFTOOL) return process.env.SHOOTS_EXIFTOOL;
  const root = path.join(homedir(), '.shoots', 'bin', 'exiftool');
  if (!existsSync(root)) return undefined;
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  for (const version of readdirSync(root)) {
    for (const name of ['exiftool.exe', 'exiftool']) {
      const candidate = path.join(root, version, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Tests that write XMP need exiftool; without one they are skipped, not failed. */
export const EXIFTOOL = findExiftool();

// Subprocess tests get this through Sandbox.env, but the in-process ones call
// straight into the adapter and resolve exiftool from their own environment.
// Setting it here means both kinds borrow the same binary.
if (EXIFTOOL) process.env.SHOOTS_EXIFTOOL = EXIFTOOL;

export interface Sandbox {
  /** SHOOTS_HOME for this test. */
  home: string;
  /** Root of the fake catalog. */
  catalog: string;
  /** Env to hand to a spawned CLI. */
  env: Record<string, string>;
  dispose(): Promise<void>;
}

/**
 * A nested, dated catalog with a deliberate basename collision across two days.
 *
 * `2026-08-02/IMG_0001.jpg` and `2026-08-03/IMG_0001.jpg` are the shape that
 * flattened every sidecar into one file. Any test that writes sidecars must see
 * two distinct ones or the collision is back.
 */
export async function makeSandbox(): Promise<Sandbox> {
  const base = await mkdtemp(path.join(tmpdir(), 'shoots-test-'));
  const home = path.join(base, 'home');
  const catalog = path.join(base, 'catalog');
  const days = ['2026-08-02', '2026-08-03'];
  for (const day of days) await mkdir(path.join(catalog, '2026', day), { recursive: true });
  await mkdir(home, { recursive: true });

  for (const [i, day] of days.entries()) {
    await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 30 + i * 90, g: 110, b: 190 } } })
      .jpeg()
      .toFile(path.join(catalog, '2026', day, 'IMG_0001.jpg'));
  }

  return {
    home,
    catalog,
    env: {
      ...(process.env as Record<string, string>),
      SHOOTS_HOME: home,
      ...(EXIFTOOL ? { SHOOTS_EXIFTOOL: EXIFTOOL } : {}),
    },
    dispose: () => rm(base, { recursive: true, force: true }),
  };
}

/** Absolute path of a fixture photograph. */
export function photo(sandbox: Sandbox, day: string): string {
  return path.join(sandbox.catalog, '2026', day, 'IMG_0001.jpg');
}

/** Where that photograph's sidecar belongs: beside it, never in the root. */
export function sidecar(sandbox: Sandbox, day: string): string {
  return path.join(sandbox.catalog, '2026', day, 'IMG_0001.xmp');
}
