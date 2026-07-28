/**
 * `develop refresh-targets` — re-read the supervised targets of an existing
 * dataset without recomputing a single pixel.
 *
 * The expensive half of `develop export` is the CLIP embedding and the neutral
 * baseline render; the targets are a cheap exiftool pass over the sidecars. When
 * the target side changes — a tag read under the wrong name, a new parameter in
 * the schema, a sharper definition of "edited" — re-exporting the whole catalog
 * costs hours to recompute features that did not change. This rebuilds only
 * `develop` / `asShot` / `baseProfile` / `curve` / `treatment` against the files
 * on disk and keeps `embedding` / `features` as they are.
 *
 * The output is a dataset a fresh export would have produced today, so records
 * that no longer qualify as edited are dropped (and counted, never silently).
 */
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { readMetadata, type ExifRecord } from '@shoots/imaging';
import { loadDataset } from '../dataset/load.js';
import { startPhase } from '../../progress.js';
import { logWarn, makeIo, printHuman, printJson } from '../../io.js';
import { ensureExiftoolReady } from '../../tools.js';
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
} from '../adapters/acr/ingest.js';

export interface RefreshArgs {
  data: string;
  out: string;
  /** Keep records that no longer look edited (default: drop them, like export). */
  keepUnedited?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export async function runRefreshTargets(args: RefreshArgs): Promise<void> {
  const io = makeIo(args);
  const dataset = await loadDataset(args.data);
  if (dataset.results.length === 0) {
    printHuman(io, 'Dataset has no records.');
    return;
  }
  if (!(await ensureExiftoolReady(io))) return;

  const files = dataset.results.map((r) => r.file);

  // crs targets, from the sidecar next to each image (or the image itself).
  const developSrcByFile = new Map(files.map((f) => [f, developSource(f)] as const));
  const crsPaths = [...new Set(developSrcByFile.values())];
  const crsPhase = startPhase(io, 'Reading develop settings');
  const crsRecords = await readMetadata(crsPaths, {
    tags: CRS_TAG_ARGS,
    onProgress: (done, total) => crsPhase.update(`${done}/${total}`),
  });
  crsPhase.done(`${crsPaths.length} files`);
  const crsByPath = new Map<string, ExifRecord>();
  for (const rec of crsRecords) crsByPath.set(path.resolve(rec.SourceFile), rec);
  const crsFor = (file: string): ExifRecord | undefined => crsByPath.get(path.resolve(developSrcByFile.get(file)!));

  warnNeverSeenTargets(io, crsRecords);

  // As-shot EXIF, from the image files themselves.
  const metaPhase = startPhase(io, 'Reading as-shot metadata');
  const exifRecords = await readMetadata(files, {
    tags: [...META_TAGS],
    onProgress: (done, total) => metaPhase.update(`${done}/${total}`),
  });
  metaPhase.done(`${files.length} files`);
  const exifByPath = new Map<string, ExifRecord>();
  for (const rec of exifRecords) exifByPath.set(path.resolve(rec.SourceFile), rec);

  const out = createWriteStream(args.out, { encoding: 'utf8' });
  const write = async (line: string): Promise<void> => {
    if (!out.write(line)) await once(out, 'drain');
  };

  let refreshed = 0;
  let unreadable = 0;
  let dropped = 0;
  for (const record of dataset.results) {
    const crs = crsFor(record.file);
    const exif = exifByPath.get(path.resolve(record.file));
    // Neither source responded: the file moved, the share is offline, or the
    // sidecar is gone. Carry the record through untouched rather than silently
    // turning a real edit into an empty one.
    if (!crs && !exif) {
      unreadable++;
      await write(JSON.stringify(record) + '\n');
      continue;
    }
    const develop = readDevelop(crs);
    const curve = readCurve(crs);
    if (!args.keepUnedited && !isEdited(develop, curve, crs)) {
      dropped++;
      continue;
    }
    const baseProfile = readBaseProfile(crs);
    await write(
      JSON.stringify({
        ...record,
        develop,
        asShot: readAsShot(crs, exif),
        treatment: deriveTreatment(develop),
        ...(baseProfile ? { baseProfile } : {}),
        ...(curve ? { curve } : {}),
      }) + '\n',
    );
    refreshed++;
  }

  const summary = { total: dataset.results.length, refreshed, dropped, unreadable };
  await write(
    JSON.stringify({
      _type: 'develop-meta',
      command: 'develop-export',
      model: dataset.model,
      dim: dataset.dim,
      colorFeatureNames: dataset.colorFeatureNames,
      colorDim: dataset.colorDim,
      baseline: dataset.baseline,
      summary,
    }) + '\n',
  );
  out.end();
  await once(out, 'finish');

  if (unreadable > 0) {
    logWarn(`${unreadable} record(s) kept unchanged — their files could not be read (moved, or the share is offline)`);
  }
  if (io.json) {
    printJson({ command: 'develop-refresh-targets', out: args.out, summary });
    return;
  }
  printHuman(io, `Refreshed ${refreshed}/${dataset.results.length} records → ${args.out}`);
  if (dropped > 0) {
    printHuman(io, `  dropped ${dropped} no longer carrying a real edit (pass --keep-unedited to retain them)`);
  }
}
