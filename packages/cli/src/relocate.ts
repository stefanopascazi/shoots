/**
 * Relocate rejected frames into a destination tree that mirrors their position
 * under the scan root, so a catalog/date structure is preserved rather than
 * flattened. Keepers are never touched by design — only the callers decide what
 * counts as a reject; this module just moves (or copies) one file.
 */
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { moveMarks } from './triage/store.js';

export interface RelocateOptions {
  /** Move the file (default). Set false to copy and leave the original in place. */
  move?: boolean;
}

/**
 * Destination path that mirrors `file`'s location under `root` into `destRoot`.
 * Files outside `root` (shouldn't happen) fall back to their basename.
 */
export function mirrorDestination(root: string, file: string, destRoot: string): string {
  const rel = path.relative(root, path.resolve(file));
  const safe = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(file);
  return path.join(destRoot, safe);
}

/**
 * Move (default) or copy `file` into `destRoot`, preserving its path under
 * `root`. Cross-device moves fall back to copy + unlink. Returns the written path.
 */
export async function relocate(
  root: string,
  file: string,
  destRoot: string,
  options: RelocateOptions = {},
): Promise<string> {
  const target = mirrorDestination(root, file, destRoot);
  await mkdir(path.dirname(target), { recursive: true });
  if (options.move ?? true) {
    try {
      await rename(file, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        // Different volume: rename can't cross it, so copy then remove.
        await copyFile(file, target);
        await unlink(file);
      } else {
        throw err;
      }
    }
  } else {
    await copyFile(file, target);
  }
  // Triage marks are keyed by path, so a move that nobody reports leaves them
  // pointing at a file that is no longer there. A copy leaves the original in
  // place, and with it the marks — only a move needs following.
  if (options.move ?? true) await moveMarks(file, target);
  return target;
}
