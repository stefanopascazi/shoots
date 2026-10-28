/**
 * Clearing what training left behind, from the app: the develop working files
 * (through `develop clean`, so the CLI and the app remove the same things) and
 * the app's own history of training runs and catalog exports.
 *
 * Nothing here touches photographs, Lightroom, the rating profiles or the
 * embedding cache: they are not training output, and are costly to rebuild.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { CleanupItem, CleanupPart } from '@shoots/app';
import { sizeOf, CLEAN_PARTS, type CleanPart } from '../develop/commands/clean.js';
import type { DurableJobs } from './durableJobs.js';

export const CLEANUP_PARTS: readonly CleanupPart[] = [...CLEAN_PARTS, 'jobs', 'exports'];

/** One entry `develop clean --json` reports. */
export interface CleanedEntry {
  part: CleanPart;
  bytes: number;
}

/** Runs `develop clean --only <parts> --json`, with --dry-run to only measure. */
export type DevelopCleaner = (parts: CleanPart[], dryRun: boolean) => Promise<CleanedEntry[]>;

export interface Cleanup {
  /** What each part holds now, without removing anything. */
  preview(): Promise<CleanupItem[]>;
  /** Removes the chosen parts; returns what went. */
  run(parts: CleanupPart[]): Promise<CleanupItem[]>;
}

/** The parts of a request body that exist; anything else is dropped. */
export function parseCleanupParts(raw: unknown): CleanupPart[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((p): p is CleanupPart => CLEANUP_PARTS.includes(p as CleanupPart)))] : [];
}

export function createCleanup(durable: DurableJobs, develop: DevelopCleaner): Cleanup {
  const exportFiles = (): string[] => {
    const dir = durable.exportsFolder;
    return existsSync(dir) ? readdirSync(dir).map((f) => path.join(dir, f)) : [];
  };
  const measure = async (part: CleanupPart, paths: string[]): Promise<CleanupItem> => {
    let bytes = 0;
    for (const p of paths) bytes += await sizeOf(p);
    return { part, count: paths.length, bytes };
  };
  const appItems = async (parts: readonly CleanupPart[]): Promise<CleanupItem[]> => [
    ...(parts.includes('jobs') ? [await measure('jobs', durable.finishedFolders())] : []),
    ...(parts.includes('exports') ? [await measure('exports', exportFiles())] : []),
  ];
  const developParts = (parts: readonly CleanupPart[]): CleanPart[] =>
    parts.filter((p): p is CleanPart => (CLEAN_PARTS as readonly string[]).includes(p));

  return {
    async preview() {
      return [...summarize(await develop([...CLEAN_PARTS], true)), ...(await appItems(CLEANUP_PARTS))];
    },
    async run(parts) {
      const removed: CleanupItem[] = [];
      const wanted = developParts(parts);
      if (wanted.length > 0) removed.push(...summarize(await develop(wanted, false)));
      const app = await appItems(parts);
      if (parts.includes('jobs')) durable.forgetFinished();
      if (parts.includes('exports')) rmSync(durable.exportsFolder, { recursive: true, force: true });
      return [...removed, ...app.filter((i) => i.count > 0)];
    },
  };
}

/** `develop clean` lists every shoot on its own; the app counts them per part. */
export function summarize(entries: readonly CleanedEntry[]): CleanupItem[] {
  const byPart = new Map<CleanupPart, CleanupItem>();
  for (const e of entries) {
    const item = byPart.get(e.part) ?? { part: e.part, count: 0, bytes: 0 };
    item.count++;
    item.bytes += e.bytes;
    byPart.set(e.part, item);
  }
  return [...byPart.values()];
}
