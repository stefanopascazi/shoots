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

/** The file operation alone. Marks are the caller's business — see below. */
async function moveOrCopy(root: string, file: string, destRoot: string, move: boolean): Promise<string> {
  const target = mirrorDestination(root, file, destRoot);
  await mkdir(path.dirname(target), { recursive: true });
  if (move) {
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
  return target;
}

/**
 * Move (default) or copy `file` into `destRoot`, preserving its path under
 * `root`. Cross-device moves fall back to copy + unlink. Returns the written path.
 *
 * For more than one file use {@link relocateAll}: this follows the triage marks
 * immediately, which is a whole pass over the store per call.
 */
export async function relocate(
  root: string,
  file: string,
  destRoot: string,
  options: RelocateOptions = {},
): Promise<string> {
  const move = options.move ?? true;
  const target = await moveOrCopy(root, file, destRoot, move);
  // Triage marks are keyed by path, so a move that nobody reports leaves them
  // pointing at a file that is no longer there. A copy leaves the original in
  // place, and with it the marks — only a move needs following.
  if (move) await moveMarks(new Map([[file, target]]));
  return target;
}

export interface RelocateAllResult {
  relocated: { source: string; dest: string }[];
  errors: { file: string; error: string }[];
}

/**
 * Relocate a whole set, then follow their marks in one pass.
 *
 * The single-file {@link relocate} is right for the interactive review, where
 * decisions arrive minutes apart. For a batch it is not: following one mark
 * rewrites every store file on the machine, so a per-file call turns a reject
 * pile into quadratic work. Here the moves are collected and handed to
 * {@link moveMarks} once.
 *
 * One file that cannot be moved is reported, never thrown: the rest of the
 * batch is still worth relocating, and the caller decides what a failure means.
 */
export async function relocateAll(
  root: string,
  files: readonly string[],
  destRoot: string,
  options: RelocateOptions = {},
): Promise<RelocateAllResult> {
  const move = options.move ?? true;
  const relocated: { source: string; dest: string }[] = [];
  const errors: { file: string; error: string }[] = [];
  const moves = new Map<string, string>();

  for (const file of files) {
    try {
      const dest = await moveOrCopy(root, file, destRoot, move);
      relocated.push({ source: file, dest });
      if (move) moves.set(file, dest);
    } catch (err) {
      errors.push({
        file,
        error: `${move ? 'move' : 'copy'} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  await moveMarks(moves);
  return { relocated, errors };
}
