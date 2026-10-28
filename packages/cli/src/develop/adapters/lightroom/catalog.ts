/**
 * The catalog export the Lightroom plug-in writes for training: each photo's
 * `photo:getDevelopSettings()`, read inside Lightroom, never from a sidecar.
 *
 * The SDK names its develop settings after the crs properties (Exposure2012,
 * Temperature, ToneCurvePV2012, ConvertToGrayscale…), so a photo's settings are
 * turned into the record shape the ACR ingest already reads. One reading of what
 * an edit is, whichever store it came from.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ExifRecord } from '@shoots/imaging';
import { exifToolTag } from '../acr/ingest.js';

export const CATALOG_EXPORT_VERSION = 1;

/** A settings value as the plug-in serialises it: scalars, plus the tone curve as numbers. */
export type CatalogSetting = number | string | boolean | number[];

export interface CatalogPhoto {
  path: string;
  settings: Record<string, CatalogSetting>;
}

export interface CatalogExport {
  version: number;
  folder: string;
  photos: CatalogPhoto[];
}

/** Validates the plug-in's JSON; throws a readable error on anything else. */
export function parseCatalogExport(text: string): CatalogExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('the catalog export is not valid JSON');
  }
  const r = raw as Partial<CatalogExport> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.photos)) throw new Error('the catalog export has no photos');
  if (r.version !== CATALOG_EXPORT_VERSION) {
    throw new Error(`the catalog export is version ${String(r.version)}; this build reads version ${CATALOG_EXPORT_VERSION} — update the plug-in or shoots`);
  }
  const photos: CatalogPhoto[] = [];
  for (const p of r.photos as unknown[]) {
    const photo = p as Partial<CatalogPhoto> | null;
    if (!photo || typeof photo.path !== 'string' || !photo.settings || typeof photo.settings !== 'object') continue;
    photos.push({ path: photo.path, settings: photo.settings as Record<string, CatalogSetting> });
  }
  return { version: r.version, folder: typeof r.folder === 'string' ? r.folder : '', photos };
}

export async function loadCatalogExport(file: string): Promise<CatalogExport> {
  return parseCatalogExport(await readFile(file, 'utf8'));
}

/**
 * One photo's settings in the shape of an exiftool crs record, so `readDevelop`,
 * `readCurve`, `isEdited` and `readAsShot` read it unchanged. Keys move to
 * exiftool's spelling (`Temperature` → `ColorTemperature`); the creative profile
 * arrives as `LookName`.
 */
export function toCrsRecord(file: string, settings: Record<string, CatalogSetting>): ExifRecord {
  const record: ExifRecord = { SourceFile: file };
  for (const [key, value] of Object.entries(settings)) {
    record[exifToolTag(key)] = Array.isArray(value) ? value.join(', ') : value;
  }
  return record;
}

/** Looks a scanned file up in the export, tolerating path spelling (and case on Windows). */
export function catalogIndex(
  data: CatalogExport,
  caseInsensitive: boolean = process.platform === 'win32',
): (file: string) => CatalogPhoto | undefined {
  const key = (p: string): string => (caseInsensitive ? path.resolve(p).toLowerCase() : path.resolve(p));
  const byPath = new Map(data.photos.map((p) => [key(p.path), p]));
  return (file) => byPath.get(key(file));
}
