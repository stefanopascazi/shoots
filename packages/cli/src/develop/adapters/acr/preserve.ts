/**
 * Keeping the photographer's own metadata alive across a develop write.
 *
 * `buildXmpSidecar` templates a whole file, which is the right way to emit
 * `crs:` — the tone curve and the Look are nested elements that no
 * attribute-level merge handles cleanly. It is the wrong way to treat everything
 * *else* in a sidecar: a star rating, a colour label, keywords and captions are
 * the photographer's, and a prediction landing on top of them would be a silent
 * data loss with no undo.
 *
 * So a write is three steps — read what is there, template the `crs:`, merge the
 * rest back — and exiftool is the merge engine. Writing tags into an existing
 * `.xmp` is something it does natively and namespace-safely, which beats parsing
 * RDF with regexes by a margin that needs no arguing.
 *
 * The set below is an allowlist rather than "all XMP minus crs". An allowlist is
 * legible and testable, and the alternative sweeps up provenance and history
 * tags whose re-injection has its own failure modes.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readMetadata, writeMetadata } from '@shoots/imaging';

/**
 * Non-crs tags worth carrying across a rewrite: the annotation and authorship
 * data an editor puts in a sidecar. Ordered as exiftool group:tag so the write
 * back is unambiguous about where each lands.
 */
export const PRESERVED_TAGS = [
  'XMP:Label',
  'XMP:Rating',
  'XMP:Subject',
  'XMP:Title',
  'XMP:Description',
  'XMP:Creator',
  'XMP:Rights',
] as const;

/** Bare tag names, as exiftool reports them in `-json` output. */
const BARE_NAMES = PRESERVED_TAGS.map((t) => t.split(':')[1]!);

export type PreservedTags = Record<string, string | number | readonly (string | number)[]>;

/**
 * Read the preservable tags out of an existing sidecar. Returns an empty object
 * when the file does not exist yet (the ordinary first-write case), so callers
 * need no special casing.
 */
export async function readPreserved(sidecarPath: string): Promise<PreservedTags> {
  if (!existsSync(sidecarPath)) return {};
  const [record] = await readMetadata([sidecarPath], { tags: BARE_NAMES });
  if (!record) return {};
  const preserved: PreservedTags = {};
  for (const [i, name] of BARE_NAMES.entries()) {
    const value = record[name];
    if (value === undefined || value === null || value === '') continue;
    preserved[PRESERVED_TAGS[i]!] = value as string | number | readonly (string | number)[];
  }
  return preserved;
}

/**
 * Merge tags into an existing sidecar without disturbing what else it holds.
 * A no-op for an empty tag set, so the common "nothing to preserve, nothing to
 * annotate" path never pays for an exiftool round trip.
 */
export async function mergeIntoSidecar(sidecarPath: string, tags: PreservedTags): Promise<void> {
  if (Object.keys(tags).length === 0) return;
  // -overwrite_original: the sidecar is ours and was just written; an exiftool
  // `_original` backup next to every photograph is noise the photographer did
  // not ask for. The photographs themselves are never touched by this path.
  await writeMetadata([sidecarPath], tags, { overwriteOriginal: true });
}

/** An empty sidecar for annotations to be merged into, when none exists yet. */
const EMPTY_XMP = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""/>
 </rdf:RDF>
</x:xmpmeta>
`;

/** Create a minimal sidecar when there is none, so exiftool has a file to merge into. */
export async function ensureSidecar(sidecarPath: string): Promise<void> {
  if (existsSync(sidecarPath)) return;
  await mkdir(path.dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, EMPTY_XMP, 'utf8');
}
