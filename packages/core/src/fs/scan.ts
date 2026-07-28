import { readdir, stat } from 'node:fs/promises';
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
   * Called with the running match count as the walk progresses. Scanning a large
   * catalog over a network share costs one round-trip per entry and can take
   * minutes, so callers need a way to show liveness. Invoked frequently — keep it
   * cheap (the CLI just stores the number and lets its own timer repaint).
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

/**
 * Recursively discover RAW / processed image files under a root path.
 * The root may also be a single file. Hidden entries (dot-prefixed) are skipped.
 * Results are sorted by path for deterministic ordering.
 */
export async function scanFiles(root: string, options: ScanOptions = {}): Promise<ScannedFile[]> {
  const recursive = options.recursive ?? true;
  const kinds = options.kinds ?? ['raw', 'processed'];
  const allowed = options.extensions ? new Set(options.extensions.map((e) => e.toLowerCase())) : null;

  const rootStat = await stat(root);
  const results: ScannedFile[] = [];

  const accept = (filePath: string, size: number, mtime: Date): void => {
    const name = path.basename(filePath);
    const ext = extensionOf(name);
    if (allowed) {
      if (!allowed.has(ext)) return;
    }
    const kind = classifyExtension(ext) ?? (allowed ? 'processed' : null);
    if (kind === null || !kinds.includes(kind)) return;
    results.push({ path: filePath, name, ext, kind, size, mtime });
    options.onProgress?.(results.length);
  };

  if (rootStat.isFile()) {
    accept(path.resolve(root), rootStat.size, rootStat.mtime);
    return results;
  }

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full);
      } else if (entry.isFile()) {
        const s = await stat(full);
        accept(full, s.size, s.mtime);
      }
    }
  };

  await walk(path.resolve(root));
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}
