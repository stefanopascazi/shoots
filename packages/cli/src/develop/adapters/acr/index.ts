/**
 * The Adobe Camera Raw / Lightroom adapter — the reference implementation of
 * {@link EditAdapter}, and the one whose vocabulary the schema speaks.
 *
 * The primitives live in `ingest.ts` (reading) and `emit.ts` (writing); this
 * file is the batch orchestration that both `develop export` and
 * `develop refresh-targets` drive.
 */
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readMetadata, type ExifRecord } from '@shoots/imaging';
import type { AsShotMeta } from '../../develop/schema.js';
import type { CliIo } from '../../../io.js';
import type { EditAdapter, EditRecord, ProgressFn } from '../types.js';
import { buildXmpSidecar } from './emit.js';
import {
  CRS_TAG_ARGS,
  META_TAGS,
  deriveTreatment,
  developSource,
  isEdited,
  readAsShot,
  readBaseProfile,
  readCurve,
  readDevelop,
  warnNeverSeenTargets,
} from './ingest.js';

/** Index exiftool's output by resolved path so lookups survive path spelling. */
function byResolvedPath(records: ExifRecord[]): Map<string, ExifRecord> {
  const out = new Map<string, ExifRecord>();
  for (const rec of records) out.set(path.resolve(rec.SourceFile), rec);
  return out;
}

async function readEdits(files: string[], io: CliIo, onProgress?: ProgressFn): Promise<Map<string, EditRecord>> {
  // Several images can share one develop source (and a sidecar is cheaper to
  // open than a RAW), so read the distinct sources once.
  const sourceByFile = new Map(files.map((f) => [f, developSource(f)] as const));
  const sources = [...new Set(sourceByFile.values())];
  const records = await readMetadata(sources, { tags: CRS_TAG_ARGS, onProgress });
  const bySource = byResolvedPath(records);

  warnNeverSeenTargets(io, records);

  const out = new Map<string, EditRecord>();
  for (const file of files) {
    const crs = bySource.get(path.resolve(sourceByFile.get(file)!));
    const develop = readDevelop(crs);
    if (Object.keys(develop).length === 0) continue;
    const curve = readCurve(crs);
    const baseProfile = readBaseProfile(crs);
    out.set(file, {
      develop,
      treatment: deriveTreatment(develop),
      edited: isEdited(develop, curve, crs),
      // Handed back to readCapture: whether WB was left "As Shot", and the
      // Kelvin the photographer chose, both decide the WB delta's anchor.
      context: crs,
      ...(curve ? { curve } : {}),
      ...(baseProfile ? { baseProfile } : {}),
    });
  }
  return out;
}

async function readCapture(
  files: string[],
  edits: Map<string, EditRecord>,
  _io: CliIo,
  onProgress?: ProgressFn,
): Promise<Map<string, AsShotMeta>> {
  const records = await readMetadata(files, { tags: [...META_TAGS], onProgress });
  const byFile = byResolvedPath(records);
  const out = new Map<string, AsShotMeta>();
  for (const file of files) {
    const crs = edits.get(file)?.context as ExifRecord | undefined;
    out.set(file, readAsShot(crs, byFile.get(path.resolve(file))));
  }
  return out;
}

export const acrAdapter: EditAdapter = {
  id: 'acr',
  label: 'Adobe Camera Raw / Lightroom (XMP crs sidecars)',
  readEdits,
  readCapture,
  async writeEdit(develop, targetPath) {
    await writeFile(targetPath, buildXmpSidecar(develop), 'utf8');
  },
  sidecarPathFor(sourceFile, outputDir) {
    return path.join(outputDir, `${path.parse(sourceFile).name}.xmp`);
  },
};
