/**
 * Checking a catalog export against what the engine reads — for the field test.
 *
 * The plug-in's "export only" sends each photo's settings twice: filtered, as
 * training receives them, and `raw`, exactly as `getDevelopSettings()` returned
 * them. This compares the two vocabularies: which crs names the engine expects
 * never arrived (a naming mismatch reads as "never edited"), which keys arrived
 * that it does not read, and what shape the tone curve and the Look really have.
 */
import type { CatalogInspection } from '@shoots/app';
import { CRS_TARGET_TAGS } from '../acr/ingest.js';
import { catalogAdapter } from './index.js';
import { parseCatalogExport } from './catalog.js';

/** Settings the engine reads besides the prediction targets. */
const CONTEXT_KEYS = new Set(['WhiteBalance', 'ToneCurvePV2012', 'CameraProfile', 'Look', 'LookName']);

/** Keys whose shape decides how the plug-in must serialise them. */
const SHAPED_KEYS = ['ToneCurvePV2012', 'Look'];

/** A short description of a value: "number", "array of 6 numbers", "object: Amount, Name, UUID". */
export function describeShape(value: unknown): string {
  if (Array.isArray(value)) {
    const kinds = [...new Set(value.map((v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)))];
    return `array of ${value.length} ${kinds.length === 1 ? `${kinds[0]}s` : `mixed (${kinds.join(', ')})`}`;
  }
  if (value && typeof value === 'object') return `object: ${Object.keys(value).sort().join(', ')}`;
  return value === null ? 'null' : typeof value;
}

export async function inspectCatalogExport(text: string, file: string): Promise<CatalogInspection> {
  const data = parseCatalogExport(text);
  const raws = (JSON.parse(text) as { photos: Array<{ raw?: Record<string, unknown> }> }).photos
    .map((p) => p?.raw)
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');

  const seen = new Set<string>();
  for (const p of data.photos) for (const k of Object.keys(p.settings)) seen.add(k);

  const rawKeys = new Set<string>();
  const shapes: Record<string, string> = {};
  for (const raw of raws) {
    for (const [k, v] of Object.entries(raw)) {
      rawKeys.add(k);
      if (SHAPED_KEYS.includes(k) && !(k in shapes)) shapes[k] = describeShape(v);
    }
  }
  const targets = new Set(CRS_TARGET_TAGS);

  const files = data.photos.map((p) => p.path);
  const edits = await catalogAdapter(data).readEdits(files, { json: true, verbose: false });
  let edited = 0;
  let bw = 0;
  for (const e of edits.values()) {
    if (!e.edited) continue;
    edited++;
    if (e.treatment === 'bw') bw++;
  }

  return {
    file,
    folder: data.folder,
    photos: data.photos.length,
    withSettings: data.photos.filter((p) => Object.keys(p.settings).length > 0).length,
    edited,
    bw,
    raw: raws.length > 0,
    missing: CRS_TARGET_TAGS.filter((t) => !seen.has(t)),
    unknown: [...rawKeys].filter((k) => !targets.has(k) && !CONTEXT_KEYS.has(k)).sort(),
    shapes,
  };
}
