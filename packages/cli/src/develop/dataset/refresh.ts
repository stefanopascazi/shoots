/**
 * Re-read a dataset's supervised targets from the files as they are now.
 *
 * The expensive half of `develop export` is the CLIP embedding and the neutral
 * baseline render; the targets are a cheap pass over the editor's sidecars. This
 * rebuilds only `develop` / `asShot` / `baseProfile` / `look` / `curve` /
 * `treatment` and keeps `embedding` / `features` untouched.
 *
 * Two callers, one job. `develop refresh-targets` uses it when the target side
 * of the schema changed; `develop learn` uses it because a shoot exported for
 * prediction was read *before* the photographer developed it — its features are
 * still valid, its targets are a blank page that has since been written on.
 */
import { startPhase } from '../../progress.js';
import { DEFAULT_EDITOR, resolveAdapter } from '../adapters/registry.js';
import type { makeIo } from '../../io.js';
import type { DevelopDataset, DevelopExportResult } from '../types.js';

export interface RefreshSummary {
  total: number;
  refreshed: number;
  unedited: number;
  /** Files that could not be read at all — moved, or the share is offline. */
  unreadable: number;
}

export interface RefreshedTargets {
  records: DevelopExportResult[];
  /** Distinct Looks seen, name → the editor's own serialization. */
  looks: Map<string, string>;
  summary: RefreshSummary;
}

/**
 * @param records The dataset rows to re-read, in order.
 * @returns The rows a fresh export would produce today, same order, same length.
 *
 * A record whose file cannot be read is carried through untouched rather than
 * silently turned into an empty edit — losing a real edit to an offline share is
 * not a refresh, it is data loss.
 */
export async function refreshTargets(
  records: readonly DevelopExportResult[],
  io: ReturnType<typeof makeIo>,
  options: { editor?: string; carryLooks?: Record<string, string> } = {},
): Promise<RefreshedTargets> {
  const adapter = resolveAdapter(options.editor ?? DEFAULT_EDITOR);
  const files = records.map((r) => r.file);

  const editPhase = startPhase(io, 'Reading develop settings');
  const edits = await adapter.readEdits(files, io, (done, total) => editPhase.update(`${done}/${total}`));
  editPhase.done(`${files.length} files`);

  const capturePhase = startPhase(io, 'Reading capture metadata');
  const capture = await adapter.readCapture(files, edits, io, (done, total) => capturePhase.update(`${done}/${total}`));
  capturePhase.done(`${files.length} files`);

  const looks = new Map<string, string>(Object.entries(options.carryLooks ?? {}));
  const out: DevelopExportResult[] = [];
  const summary: RefreshSummary = { total: records.length, refreshed: 0, unedited: 0, unreadable: 0 };

  for (const record of records) {
    const edit = edits.get(record.file);
    const asShot = capture.get(record.file);
    if (!edit && !asShot) {
      summary.unreadable++;
      out.push(record);
      continue;
    }
    if (!edit?.edited) summary.unedited++;
    if (edit?.look && edit.lookXml) looks.set(edit.look, edit.lookXml);
    // Spread last so a field the editor no longer reports is dropped rather than
    // surviving from the old record: a refresh must produce what a fresh export
    // would have, not a merge of the two.
    const { baseProfile: _p, look: _l, curve: _c, ...carried } = record;
    out.push({
      ...carried,
      develop: edit?.develop ?? {},
      ...(asShot ? { asShot } : {}),
      treatment: edit?.treatment ?? 'color',
      edited: edit?.edited ?? false,
      ...(edit?.baseProfile ? { baseProfile: edit.baseProfile } : {}),
      ...(edit?.look ? { look: edit.look } : {}),
      ...(edit?.curve ? { curve: edit.curve } : {}),
    });
    summary.refreshed++;
  }

  return { records: out, looks, summary };
}

/** The meta line a refreshed dataset carries, preserving everything but the targets. */
export function refreshedMeta(
  dataset: DevelopDataset,
  looks: Map<string, string>,
  summary: Record<string, number>,
): Record<string, unknown> {
  return {
    _type: 'develop-meta',
    command: 'develop-export',
    model: dataset.model,
    dim: dataset.dim,
    colorFeatureNames: dataset.colorFeatureNames,
    colorDim: dataset.colorDim,
    baseline: dataset.baseline,
    ...(looks.size > 0 ? { looks: Object.fromEntries(looks) } : {}),
    // Carried over, never re-stamped: refreshing targets does not re-extract the
    // features, so the dataset is still as old as the export that produced it.
    ...(dataset.toolVersion ? { toolVersion: dataset.toolVersion } : {}),
    summary,
  };
}
