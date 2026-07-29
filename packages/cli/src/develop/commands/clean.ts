/**
 * `develop clean` — drop the per-shoot working files.
 *
 * `develop edit` keeps a dataset and a prediction record per shoot under
 * `~/.shoots/develop/export/shooting/`. Both are regenerable — the dataset from
 * the photographs, the record by predicting again — so they are cache, and cache
 * that nobody ever deletes is just disk you have stopped noticing.
 *
 * What it will NOT remove: the training dataset and the fitted profile. Those
 * cost a full export and a train to rebuild, and are what everything else
 * depends on. `--all` includes them, and says what it is doing.
 */
import path from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { developExportPath, developProfilePath, developShootsDir } from '@shoots/core';
import { logError, makeIo, printHuman, printJson } from '../../io.js';

export interface CleanArgs {
  /** Also remove the training dataset and the fitted profile. */
  all?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

interface Entry {
  path: string;
  label: string;
  bytes: number;
}

/** Total size on disk of a file or directory tree. */
async function sizeOf(target: string): Promise<number> {
  const info = await stat(target).catch(() => null);
  if (!info) return 0;
  if (info.isFile()) return info.size;
  const names = await readdir(target).catch(() => [] as string[]);
  let total = 0;
  for (const name of names) total += await sizeOf(path.join(target, name));
  return total;
}

const human = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB`
  : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1e3))} kB`;

export async function runClean(args: CleanArgs): Promise<void> {
  const io = makeIo(args);
  const shoots = developShootsDir();

  const entries: Entry[] = [];
  if (existsSync(shoots)) {
    for (const name of await readdir(shoots)) {
      const full = path.join(shoots, name);
      entries.push({ path: full, label: `shoot ${name}`, bytes: await sizeOf(full) });
    }
  }
  if (args.all) {
    for (const [target, label] of [
      [developExportPath(), 'training dataset'],
      [developProfilePath(), 'fitted profile'],
    ] as const) {
      if (existsSync(target)) entries.push({ path: target, label, bytes: await sizeOf(target) });
    }
  }

  const total = entries.reduce((a, e) => a + e.bytes, 0);

  if (entries.length === 0) {
    if (io.json) printJson({ command: 'develop-clean', dryRun: !!args.dryRun, removed: [], bytes: 0 });
    else printHuman(io, `Nothing to clean under ${shoots}`);
    return;
  }

  if (io.json) {
    if (!args.dryRun) {
      for (const e of entries) await rm(e.path, { recursive: true, force: true });
    }
    printJson({
      command: 'develop-clean',
      dryRun: !!args.dryRun,
      removed: entries.map((e) => ({ path: e.path, label: e.label, bytes: e.bytes })),
      bytes: total,
    });
    return;
  }

  printHuman(io, args.dryRun ? 'Dry run — nothing removed.\n' : 'Removing:\n');
  for (const e of entries) printHuman(io, `  ${e.label.padEnd(24)} ${human(e.bytes).padStart(9)}   ${e.path}`);
  printHuman(io, `\n  ${entries.length} item(s), ${human(total)}`);

  if (args.dryRun) {
    printHuman(io, '\nRe-run without --dry-run to remove them.');
    return;
  }

  let removed = 0;
  for (const e of entries) {
    try {
      await rm(e.path, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logError(`could not remove ${e.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  printHuman(io, `\nRemoved ${removed}/${entries.length}.`);
  if (args.all) {
    printHuman(io, 'The profile is gone too — `shoots develop init <catalog>` rebuilds it.');
  }
}
