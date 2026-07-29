/**
 * `develop refresh-targets` — re-read the supervised targets of an existing
 * dataset without recomputing a single pixel.
 *
 * The expensive half of `develop export` is the CLIP embedding and the neutral
 * baseline render; the targets are a cheap pass over the editor's sidecars. When
 * the target side changes — a tag read under the wrong name, a new parameter in
 * the schema, a sharper definition of "edited" — re-exporting the whole catalog
 * costs hours to recompute features that did not change. This rebuilds only
 * `develop` / `asShot` / `baseProfile` / `look` / `curve` / `treatment` against
 * the files on disk and keeps `embedding` / `features` as they are.
 *
 * The output is a dataset a fresh export would have produced today, so records
 * that no longer qualify as edited are dropped (and counted, never silently).
 */
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { loadDataset } from '../dataset/load.js';
import { startPhase } from '../../progress.js';
import { logWarn, makeIo, printHuman, printJson } from '../../io.js';
import { ensureExiftoolReady } from '../../tools.js';
import { DEFAULT_EDITOR, resolveAdapter } from '../adapters/registry.js';

export interface RefreshArgs {
  data: string;
  out: string;
  /** Which editor's develop settings to read (see adapters/registry.ts). */
  editor?: string;
  /**
   * Drop records that no longer look edited instead of marking them.
   *
   * Off by default: an unedited frame is not a training target but it does
   * describe its session, which is where most of a develop decision lives. The
   * trainer filters on the `edited` flag, so keeping them costs nothing and
   * throwing them away costs the session description.
   */
  dropUnedited?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export async function runRefreshTargets(args: RefreshArgs): Promise<void> {
  const io = makeIo(args);
  const adapter = resolveAdapter(args.editor ?? DEFAULT_EDITOR);
  const dataset = await loadDataset(args.data);
  if (dataset.results.length === 0) {
    printHuman(io, 'Dataset has no records.');
    return;
  }
  if (!(await ensureExiftoolReady(io))) return;

  const files = dataset.results.map((r) => r.file);

  const editPhase = startPhase(io, 'Reading develop settings');
  const edits = await adapter.readEdits(files, io, (done, total) => editPhase.update(`${done}/${total}`));
  editPhase.done(`${files.length} files`);

  const capturePhase = startPhase(io, 'Reading capture metadata');
  const capture = await adapter.readCapture(files, edits, io, (done, total) => capturePhase.update(`${done}/${total}`));
  capturePhase.done(`${files.length} files`);

  const out = createWriteStream(args.out, { encoding: 'utf8' });
  const write = async (line: string): Promise<void> => {
    if (!out.write(line)) await once(out, 'drain');
  };

  let refreshed = 0;
  let unreadable = 0;
  let dropped = 0;
  let unedited = 0;
  /** Distinct Looks seen, name → the editor's own serialization (see the meta line). */
  const looks = new Map<string, string>(Object.entries(dataset.looks ?? {}));
  for (const record of dataset.results) {
    const edit = edits.get(record.file);
    const asShot = capture.get(record.file);
    // Nothing came back for this file: it moved, the share is offline, or the
    // sidecar is gone. Carry the record through untouched rather than silently
    // turning a real edit into an empty one.
    if (!edit && !asShot) {
      unreadable++;
      await write(JSON.stringify(record) + '\n');
      continue;
    }
    // No edit at all is a normal state for a whole-folder export: the file was
    // never touched. It still describes its session, so it is kept (and marked)
    // rather than dropped.
    if (!edit?.edited) {
      if (args.dropUnedited) {
        dropped++;
        continue;
      }
      unedited++;
    }
    if (edit?.look && edit.lookXml) looks.set(edit.look, edit.lookXml);
    // Spread last so a field the editor no longer reports is dropped rather than
    // surviving from the old record: a refresh must produce what a fresh export
    // would have, not a merge of the two.
    const { baseProfile: _p, look: _l, curve: _c, ...carried } = record;
    await write(
      JSON.stringify({
        ...carried,
        develop: edit?.develop ?? {},
        ...(asShot ? { asShot } : {}),
        treatment: edit?.treatment ?? 'color',
        edited: edit?.edited ?? false,
        ...(edit?.baseProfile ? { baseProfile: edit.baseProfile } : {}),
        ...(edit?.look ? { look: edit.look } : {}),
        ...(edit?.curve ? { curve: edit.curve } : {}),
      }) + '\n',
    );
    refreshed++;
  }

  const summary = { total: dataset.results.length, refreshed, dropped, unedited, unreadable };
  await write(
    JSON.stringify({
      _type: 'develop-meta',
      command: 'develop-export',
      model: dataset.model,
      dim: dataset.dim,
      colorFeatureNames: dataset.colorFeatureNames,
      colorDim: dataset.colorDim,
      baseline: dataset.baseline,
      ...(looks.size > 0 ? { looks: Object.fromEntries(looks) } : {}),
      summary,
    }) + '\n',
  );
  out.end();
  await once(out, 'finish');

  if (unreadable > 0) {
    logWarn(`${unreadable} record(s) kept unchanged — their files could not be read (moved, or the share is offline)`);
  }
  if (io.json) {
    printJson({ command: 'develop-refresh-targets', editor: adapter.id, out: args.out, summary });
    return;
  }
  printHuman(io, `Refreshed ${refreshed}/${dataset.results.length} records → ${args.out}`);
  if (dropped > 0) {
    printHuman(io, `  dropped ${dropped} no longer carrying a real edit`);
  } else if (unedited > 0) {
    printHuman(io, `  ${unedited} carry no real edit: kept to describe their session, not trained on`);
  }
}
