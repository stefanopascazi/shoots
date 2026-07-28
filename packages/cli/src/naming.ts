/**
 * Shared naming logic for `shoots import` and `shoots rename`:
 * EXIF lookup → template rendering → collision-safe target names.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { renderTemplate, type ScannedFile } from '@shoots/core';
import {
  ExiftoolNotFoundError,
  getTagString,
  parseExifDate,
  readMetadata,
  type ExifRecord,
} from '@shoots/imaging';
import { logVerbose, logWarn, type CliIo } from './io.js';
import { startPhase } from './progress.js';

export interface FileNamingInfo {
  file: ScannedFile;
  date: Date;
  dateSource: 'exif' | 'mtime';
  camera: string | null;
  lens: string | null;
}

/**
 * Read capture metadata for a batch of files, falling back to filesystem
 * mtime / unknown camera when exiftool is unavailable or a file has no EXIF.
 */
export async function collectNamingInfo(io: CliIo, files: ScannedFile[]): Promise<FileNamingInfo[]> {
  const byPath = new Map<string, ExifRecord>();
  const phase = startPhase(io, 'Reading capture metadata');
  try {
    const records = await readMetadata(
      files.map((f) => f.path),
      {
        tags: ['DateTimeOriginal', 'CreateDate', 'Model', 'LensModel', 'LensID'],
        onProgress: (done, total) => phase.update(`${done}/${total}`),
      },
    );
    for (const record of records) {
      byPath.set(path.resolve(record.SourceFile), record);
    }
    phase.done(`${records.length}/${files.length} files`);
    logVerbose(io, `exiftool returned metadata for ${records.length}/${files.length} files`);
  } catch (err) {
    phase.done('failed');
    if (err instanceof ExiftoolNotFoundError) {
      logWarn(`${err.message} Falling back to file modification times; {camera}/{lens} will be unknown.`);
    } else {
      throw err;
    }
  }

  return files.map((file) => {
    const record = byPath.get(path.resolve(file.path));
    const exifDate = record
      ? parseExifDate(getTagString(record, 'DateTimeOriginal') ?? getTagString(record, 'CreateDate'))
      : null;
    return {
      file,
      date: exifDate ?? file.mtime,
      dateSource: exifDate ? 'exif' : 'mtime',
      camera: record ? getTagString(record, 'Model') : null,
      lens: record ? (getTagString(record, 'LensModel') ?? getTagString(record, 'LensID')) : null,
    };
  });
}

export interface NamingPlanEntry {
  source: string;
  dest: string;
  dateSource: 'exif' | 'mtime';
  unchanged: boolean;
}

/**
 * Build collision-free target paths. Sequence numbers follow capture-date
 * order. Collisions (within the batch or with existing files on disk) get a
 * `_2`, `_3`, ... suffix — existing files are never overwritten.
 */
export function buildNamingPlan(
  infos: FileNamingInfo[],
  pattern: string,
  destDirFor: (info: FileNamingInfo) => string,
): NamingPlanEntry[] {
  const ordered = [...infos].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || a.file.path.localeCompare(b.file.path),
  );
  const claimed = new Set<string>();

  return ordered.map((info, index) => {
    const rendered = renderTemplate(pattern, {
      date: info.date,
      camera: info.camera,
      lens: info.lens,
      ext: info.file.ext,
      originalName: path.parse(info.file.name).name,
      seq: index + 1,
    });
    const destDir = destDirFor(info);

    const candidatePath = (name: string) => path.join(destDir, name);
    const isTaken = (p: string) => {
      const key = p.toLowerCase();
      if (claimed.has(key)) return true;
      // A file already at its own target name is not a collision.
      if (existsSync(p) && path.resolve(p) !== path.resolve(info.file.path)) return true;
      return false;
    };

    let dest = candidatePath(rendered);
    if (isTaken(dest)) {
      const parsed = path.parse(rendered);
      for (let n = 2; ; n++) {
        dest = candidatePath(`${parsed.name}_${n}${parsed.ext}`);
        if (!isTaken(dest)) break;
      }
    }
    claimed.add(dest.toLowerCase());

    return {
      source: info.file.path,
      dest,
      dateSource: info.dateSource,
      unchanged: path.resolve(dest) === path.resolve(info.file.path),
    };
  });
}
