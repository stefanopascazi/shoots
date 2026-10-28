/**
 * What a command works on: a folder (or single file) to scan, or an explicit
 * list of files handed over by a host editor (`--files-from`), such as the
 * Lightroom plugin passing its current selection.
 */
import { readFile } from 'node:fs/promises';
import { parsePathList, scanFileList, scanFiles, type ScannedFile, type SkippedFile } from '@shoots/core';

export interface Targets {
  files: ScannedFile[];
  /** Listed paths that are gone or not images; always empty for a folder scan. */
  skipped: SkippedFile[];
  /** True when the files came from a list rather than a folder. */
  fromList: boolean;
}

export type TargetsResult = { ok: true; targets: Targets } | { ok: false; error: string };

export async function resolveTargets(
  targetPath: string | undefined,
  filesFrom: string | undefined,
  onProgress?: (found: number) => void,
): Promise<TargetsResult> {
  if (targetPath && filesFrom) return { ok: false, error: 'pass either <path> or --files-from, not both' };
  if (!targetPath && !filesFrom) return { ok: false, error: 'missing <path> (or --files-from <list>)' };

  if (filesFrom) {
    let text: string;
    try {
      text = await readFile(filesFrom, 'utf8');
    } catch (err) {
      return { ok: false, error: `cannot read --files-from ${filesFrom}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const { files, skipped } = await scanFileList(parsePathList(text));
    onProgress?.(files.length);
    return { ok: true, targets: { files, skipped, fromList: true } };
  }

  const files = await scanFiles(targetPath!, { onProgress });
  return { ok: true, targets: { files, skipped: [], fromList: false } };
}

/** A skipped path in the `{ file, error }` shape every command's errors use. */
export function skippedAsError(s: SkippedFile): { file: string; error: string } {
  return { file: s.path, error: s.reason === 'missing' ? 'file not found' : 'unsupported file type' };
}
