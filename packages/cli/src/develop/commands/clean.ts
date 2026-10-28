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
 *
 * Nor the feedback journal, `--all` or not. It is the only develop artifact that
 * is not regenerable at any price: it records what photographs looked like the
 * day they were developed, and re-reading them now cannot recover that. It goes
 * only when named: `--only journal`.
 *
 * `--only <parts>` picks exactly what goes — the app's clean-up screen drives it.
 * `calibration` strips the calibration from the profile and keeps the fit.
 */
import path from 'node:path';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { developExportPath, developFeedbackPath, developProfilePath, developShootsDir } from '@shoots/core';
import { logError, makeIo, printHuman, printJson } from '../../io.js';

/** What `develop clean` can remove, each on its own. */
export const CLEAN_PARTS = ['shoots', 'dataset', 'profile', 'calibration', 'journal'] as const;
export type CleanPart = (typeof CLEAN_PARTS)[number];

export interface CleanArgs {
  /** Also remove the training dataset and the fitted profile. */
  all?: boolean;
  /** Comma-separated parts; replaces the default selection and --all. */
  only?: string;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
}

interface Entry {
  part: CleanPart;
  path: string;
  label: string;
  bytes: number;
  /** Instead of deleting `path`: rewrite it (the calibration lives inside the profile). */
  apply?: () => Promise<void>;
}

/** The parts a set of flags selects; throws on an unknown name. */
export function selectedParts(args: Pick<CleanArgs, 'all' | 'only'>): Set<CleanPart> {
  if (args.only !== undefined) {
    const names = args.only.split(',').map((p) => p.trim()).filter(Boolean);
    const unknown = names.filter((n) => !CLEAN_PARTS.includes(n as CleanPart));
    if (unknown.length > 0) throw new Error(`unknown part '${unknown.join(', ')}' (available: ${CLEAN_PARTS.join(', ')})`);
    return new Set(names as CleanPart[]);
  }
  return new Set<CleanPart>(args.all ? ['shoots', 'dataset', 'profile'] : ['shoots']);
}

/** The profile without its calibration, or undefined when it carries none. */
async function uncalibrated(profilePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Record<string, unknown>;
    if (!profile.calibration) return undefined;
    delete profile.calibration;
    return profile;
  } catch {
    return undefined;
  }
}

/** What would go, part by part, under the current SHOOTS_HOME. */
export async function cleanEntries(parts: ReadonlySet<CleanPart>): Promise<Entry[]> {
  const entries: Entry[] = [];
  const shoots = developShootsDir();
  if (parts.has('shoots') && existsSync(shoots)) {
    for (const name of await readdir(shoots)) {
      const full = path.join(shoots, name);
      entries.push({ part: 'shoots', path: full, label: `shoot ${name}`, bytes: await sizeOf(full) });
    }
  }
  for (const [part, target, label] of [
    ['dataset', developExportPath(), 'training dataset'],
    ['profile', developProfilePath(), 'fitted profile'],
    ['journal', developFeedbackPath(), 'feedback journal'],
  ] as const) {
    if (parts.has(part) && existsSync(target)) entries.push({ part, path: target, label, bytes: await sizeOf(target) });
  }
  // Pointless when the profile goes anyway.
  if (parts.has('calibration') && !parts.has('profile')) {
    const profilePath = developProfilePath();
    const stripped = await uncalibrated(profilePath);
    if (stripped) {
      entries.push({
        part: 'calibration',
        path: profilePath,
        label: 'calibration',
        bytes: 0,
        apply: () => writeFile(profilePath, JSON.stringify(stripped, null, 2) + '\n', 'utf8'),
      });
    }
  }
  return entries;
}

const removeEntry = (e: Entry): Promise<void> => (e.apply ? e.apply() : rm(e.path, { recursive: true, force: true }));

/** Total size on disk of a file or directory tree. */
export async function sizeOf(target: string): Promise<number> {
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

  let parts: Set<CleanPart>;
  try {
    parts = selectedParts(args);
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }
  const entries = await cleanEntries(parts);

  const total = entries.reduce((a, e) => a + e.bytes, 0);

  if (entries.length === 0) {
    if (io.json) printJson({ command: 'develop-clean', dryRun: !!args.dryRun, removed: [], bytes: 0 });
    else printHuman(io, `Nothing to clean under ${shoots}`);
    return;
  }

  if (io.json) {
    if (!args.dryRun) {
      for (const e of entries) await removeEntry(e);
    }
    printJson({
      command: 'develop-clean',
      dryRun: !!args.dryRun,
      removed: entries.map((e) => ({ part: e.part, path: e.path, label: e.label, bytes: e.bytes })),
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
      await removeEntry(e);
      removed++;
    } catch (err) {
      logError(`could not remove ${e.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  printHuman(io, `\nRemoved ${removed}/${entries.length}.`);
  if (parts.has('profile')) {
    printHuman(io, 'The profile is gone too — `shoots develop init <catalog>` rebuilds it.');
  }
  if (!parts.has('journal') && existsSync(developFeedbackPath())) {
    printHuman(io, `The feedback journal is untouched: ${developFeedbackPath()}`);
  }
}
