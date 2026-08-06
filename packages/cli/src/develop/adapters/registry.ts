/**
 * Which editors Shoots can read an edit from and write one back to.
 *
 * The point of the registry is that adding darktable, Capture One or a Lightroom
 * catalog reader is a new file here plus an `--editor` value, not a change to
 * the schema, the trainer or the evaluation. RapidRAW was the first test of
 * that, and it held: it speaks JSON instead of RDF, states white balance
 * relative to the capture instead of absolutely, and has no black-and-white mode
 * at all — none of which reached past its own directory.
 */
import { acrAdapter } from './acr/index.js';
import { rapidrawAdapter } from './rapidraw/index.js';
import type { EditAdapter } from './types.js';

const ADAPTERS: EditAdapter[] = [acrAdapter, rapidrawAdapter];

export const DEFAULT_EDITOR = acrAdapter.id;
export const EDITOR_IDS: string[] = ADAPTERS.map((a) => a.id);

export function resolveAdapter(id: string): EditAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) {
    throw new Error(`unknown --editor '${id}' (available: ${EDITOR_IDS.join(', ')})`);
  }
  return adapter;
}

/** The adapter can write predictions back out (not an ingest-only source). */
export function assertCanEmit(adapter: EditAdapter): void {
  if (adapter.ingestOnly || !adapter.writeEdit || !adapter.sidecarPathFor) {
    throw new Error(`editor '${adapter.id}' is read-only — it cannot write predictions back`);
  }
}
