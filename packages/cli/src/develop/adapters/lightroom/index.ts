/**
 * Lightroom Classic's catalog as a training source — ingest only.
 *
 * The plug-in path never touches a sidecar: edits come from the catalog export
 * (see catalog.ts), capture metadata from the image files, exactly as the ACR
 * adapter reads them. Predictions go back through the plug-in, not through here.
 */
import path from 'node:path';
import { readMetadata, type ExifRecord } from '@shoots/imaging';
import type { AsShotMeta } from '../../develop/schema.js';
import type { CliIo } from '../../../io.js';
import type { EditAdapter, EditRecord, ProgressFn } from '../types.js';
import { deriveTreatment, isEdited, META_TAGS, readAsShot, readBaseProfile, readCurve, readDevelop, readLookName } from '../acr/ingest.js';
import { catalogIndex, toCrsRecord, type CatalogExport } from './catalog.js';

export function catalogAdapter(data: CatalogExport): EditAdapter {
  const lookup = catalogIndex(data);

  async function readEdits(files: string[], _io: CliIo, onProgress?: ProgressFn): Promise<Map<string, EditRecord>> {
    const out = new Map<string, EditRecord>();
    for (const [i, file] of files.entries()) {
      onProgress?.(i + 1, files.length);
      const photo = lookup(file);
      if (!photo) continue;
      const crs = toCrsRecord(file, photo.settings);
      const develop = readDevelop(crs);
      if (Object.keys(develop).length === 0) continue;
      const curve = readCurve(crs);
      const baseProfile = readBaseProfile(crs);
      const look = readLookName(crs);
      out.set(file, {
        develop,
        treatment: deriveTreatment(develop),
        edited: isEdited(develop, curve, crs),
        context: crs,
        ...(curve ? { curve } : {}),
        ...(baseProfile ? { baseProfile } : {}),
        ...(look ? { look } : {}),
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
    const byFile = new Map(records.map((r) => [path.resolve(r.SourceFile), r]));
    const out = new Map<string, AsShotMeta>();
    for (const file of files) {
      out.set(file, readAsShot(edits.get(file)?.context as ExifRecord | undefined, byFile.get(path.resolve(file))));
    }
    return out;
  }

  return {
    id: 'lightroom',
    label: 'Lightroom Classic (catalog export from the plug-in)',
    readEdits,
    readCapture,
    ingestOnly: true,
  };
}
