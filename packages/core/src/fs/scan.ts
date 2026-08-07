import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

/**
 * RAW file extensions we recognize (lowercase, no dot).
 * Covers the major camera vendors; extend as needed.
 */
export const RAW_EXTENSIONS: ReadonlySet<string> = new Set([
  '3fr', // Hasselblad
  'arw', // Sony
  'cr2', // Canon
  'cr3', // Canon
  'dcr', // Kodak
  'dng', // Adobe / various
  'erf', // Epson
  'fff', // Hasselblad
  'iiq', // Phase One
  'kdc', // Kodak
  'mef', // Mamiya
  'mos', // Leaf
  'nef', // Nikon
  'nrw', // Nikon
  'orf', // Olympus
  'pef', // Pentax
  'raf', // Fujifilm
  'raw', // Panasonic / generic
  'rw2', // Panasonic
  'rwl', // Leica
  'srw', // Samsung
  'x3f', // Sigma
]);

/** Non-RAW image extensions we operate on (lowercase, no dot). */
export const PROCESSED_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'tif',
  'tiff',
  'webp',
]);

export type FileKind = 'raw' | 'processed';

export interface ScannedFile {
  /** Absolute path to the file. */
  path: string;
  /** Basename including extension. */
  name: string;
  /** Lowercase extension without the leading dot. */
  ext: string;
  kind: FileKind;
  size: number;
  mtime: Date;
}

export interface ScanOptions {
  /** Recurse into subdirectories. Default: true. */
  recursive?: boolean;
  /** Restrict to specific kinds. Default: both. */
  kinds?: FileKind[];
  /** Override the extension allow-list entirely (lowercase, no dot). */
  extensions?: string[];
  /**
   * Filesystem metadata operations in flight at once. Default: 32.
   *
   * These are round-trips, not computation: on a local disk the number barely
   * matters, and on a network share it is the difference between a scan that
   * takes seconds and one that takes minutes, because each request spends
   * almost all of its life waiting. 32 is well past the point where a local
   * filesystem stops caring and short of where an SMB server starts refusing.
   */
  concurrency?: number;
  /**
   * Called with the running match count as the walk progresses. Scanning a large
   * catalog over a network share costs one round-trip per entry and can take
   * minutes, so callers need a way to show liveness. Invoked frequently — keep it
   * cheap (the CLI just stores the number and lets its own timer repaint).
   *
   * Fires once per match while directories are being read — the part that can
   * take minutes. The metadata pass that follows works from an already-known
   * list and reports nothing, so the count stops climbing just before the end.
   */
  onProgress?: (found: number) => void;
}

/** Classify a lowercase extension (no dot) as raw/processed, or null if not an image we handle. */
export function classifyExtension(ext: string): FileKind | null {
  if (RAW_EXTENSIONS.has(ext)) return 'raw';
  if (PROCESSED_EXTENSIONS.has(ext)) return 'processed';
  return null;
}

function extensionOf(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

/** Default metadata operations in flight. See {@link ScanOptions.concurrency}. */
const DEFAULT_SCAN_CONCURRENCY = 32;

/** Map with a bounded number of promises in flight. Results keep input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Read every directory under `root`, handing each one's entries to `visit`.
 *
 * Bounded globally rather than per level: recursing with a limit applied at each
 * directory would multiply, and a deep catalog would end up with thousands of
 * requests in flight. One pool, one ceiling, however deep the tree goes.
 */
async function walkDirectories(
  root: string,
  recursive: boolean,
  limit: number,
  visit: (dir: string, entries: Dirent[]) => string[],
): Promise<void> {
  const pending: string[] = [root];
  let active = 0;

  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = (): void => {
      if (failed) return;
      if (pending.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (pending.length > 0 && active < limit) {
        const dir = pending.pop()!;
        active++;
        readdir(dir, { withFileTypes: true }).then(
          (entries) => {
            const subdirs = visit(dir, entries);
            if (recursive) pending.push(...subdirs);
            active--;
            pump();
          },
          (err: unknown) => {
            failed = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      }
    };
    pump();
  });
}

/**
 * Recursively discover RAW / processed image files under a root path.
 * The root may also be a single file. Hidden entries (dot-prefixed) are skipped.
 * Results are sorted by path for deterministic ordering.
 *
 * Two passes, and the order of them is the point. Which files are wanted is
 * decided from their names alone, and only the survivors are asked for their
 * size and mtime. A worked-on catalog carries an `.xmp` and a `.shoots.json`
 * beside every frame, so deciding first is two thirds of the metadata requests
 * never made.
 */
export async function scanFiles(root: string, options: ScanOptions = {}): Promise<ScannedFile[]> {
  const recursive = options.recursive ?? true;
  const kinds = options.kinds ?? ['raw', 'processed'];
  const allowed = options.extensions ? new Set(options.extensions.map((e) => e.toLowerCase())) : null;
  const limit = Math.max(1, options.concurrency ?? DEFAULT_SCAN_CONCURRENCY);

  /** Name → what it is, or null when it is not a file this scan wants. */
  const wanted = (name: string): { ext: string; kind: FileKind } | null => {
    const ext = extensionOf(name);
    if (allowed && !allowed.has(ext)) return null;
    const kind = classifyExtension(ext) ?? (allowed ? 'processed' : null);
    if (kind === null || !kinds.includes(kind)) return null;
    return { ext, kind };
  };

  const rootStat = await stat(root);
  if (rootStat.isFile()) {
    const resolved = path.resolve(root);
    const name = path.basename(resolved);
    const match = wanted(name);
    if (!match) return [];
    options.onProgress?.(1);
    return [{ path: resolved, name, ext: match.ext, kind: match.kind, size: rootStat.size, mtime: rootStat.mtime }];
  }

  // Pass 1: names only. No metadata request is made for a file nothing wants.
  const candidates: { path: string; name: string; ext: string; kind: FileKind }[] = [];
  await walkDirectories(path.resolve(root), recursive, limit, (dir, entries) => {
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = wanted(entry.name);
      if (!match) continue;
      candidates.push({ path: full, name: entry.name, ...match });
      // Per match, not per directory: a shoot is often one flat folder, and
      // reporting only when its listing finished would show nothing at all for
      // the whole of the part that takes the time.
      options.onProgress?.(candidates.length);
    }
    return subdirs;
  });

  // Pass 2: size and mtime for the survivors, several requests at a time.
  // A file that disappeared between the two passes is dropped rather than
  // thrown over: it is gone, so no command could have processed it anyway.
  const stats = await mapLimit(candidates, limit, async (c) => {
    try {
      return await stat(c.path);
    } catch {
      return null;
    }
  });

  const results: ScannedFile[] = [];
  for (const [i, c] of candidates.entries()) {
    const s = stats[i];
    if (s) results.push({ ...c, size: s.size, mtime: s.mtime });
  }
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}
