/**
 * `develop refresh-targets` — re-read the supervised targets of an existing
 * dataset without recomputing a single pixel.
 *
 * When the target side changes — a tag read under the wrong name, a new parameter
 * in the schema, a sharper definition of "edited" — re-exporting the whole catalog
 * costs hours to recompute features that did not change. The work itself lives in
 * dataset/refresh.ts, shared with `develop learn`; this is the file-in/file-out
 * command around it.
 *
 * The output is a dataset a fresh export would have produced today, so records
 * that no longer qualify as edited are dropped (and counted, never silently).
 */
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { loadDataset } from '../dataset/load.js';
import { refreshTargets, refreshedMeta } from '../dataset/refresh.js';
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

  const refreshed = await refreshTargets(dataset.results, io, {
    editor: args.editor,
    carryLooks: dataset.looks,
  });

  const out = createWriteStream(args.out, { encoding: 'utf8' });
  const write = async (line: string): Promise<void> => {
    if (!out.write(line)) await once(out, 'drain');
  };

  let dropped = 0;
  let unedited = 0;
  for (const record of refreshed.records) {
    if (record.edited === false) {
      if (args.dropUnedited) {
        dropped++;
        continue;
      }
      unedited++;
    }
    await write(JSON.stringify(record) + '\n');
  }

  const summary = {
    total: dataset.results.length,
    refreshed: refreshed.summary.refreshed,
    dropped,
    unedited,
    unreadable: refreshed.summary.unreadable,
  };
  await write(JSON.stringify(refreshedMeta(dataset, refreshed.looks, summary)) + '\n');
  out.end();
  await once(out, 'finish');

  if (refreshed.summary.unreadable > 0) {
    logWarn(
      `${refreshed.summary.unreadable} record(s) kept unchanged — their files could not be read (moved, or the share is offline)`,
    );
  }
  if (io.json) {
    printJson({ command: 'develop-refresh-targets', editor: adapter.id, out: args.out, summary });
    return;
  }
  printHuman(io, `Refreshed ${summary.refreshed}/${dataset.results.length} records → ${args.out}`);
  if (dropped > 0) {
    printHuman(io, `  dropped ${dropped} no longer carrying a real edit`);
  } else if (unedited > 0) {
    printHuman(io, `  ${unedited} carry no real edit: kept to describe their session, not trained on`);
  }
}
