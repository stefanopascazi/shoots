/**
 * shoots cache status | clear | prune
 *
 * The derived cache is on by default, which makes it the photographer's
 * business rather than an implementation detail: what it holds has to be
 * visible, and getting rid of it has to be one command rather than a hunt
 * through a hidden folder.
 */
import type { Command } from 'commander';
import { cacheDir } from '@shoots/core';
import { logVerbose, makeIo, printHuman, printJson } from '../io.js';
import { cacheMaxBytes, cacheUsage, enforceCacheBudget, listPacks } from '../cache/budget.js';
import { clearCache } from '../cache/store.js';

interface CacheOptions {
  json?: boolean;
  verbose?: boolean;
}

/** Human-readable size, in the units somebody would actually say out loud. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function registerCacheCommand(program: Command): void {
  const cache = program
    .command('cache')
    .description('The derived values commands reuse between runs (measurements, embeddings) — inspect or drop them');

  cache
    .command('status')
    .description('What the cache holds and how close it is to its ceiling')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runStatus);

  cache
    .command('clear')
    .description('Drop every cached value on this machine (costs only recomputation)')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runClear);

  cache
    .command('prune')
    .description('Drop the oldest shoots until the cache fits under its ceiling')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runPrune);
}

async function runStatus(options: CacheOptions): Promise<void> {
  const io = makeIo(options);
  const usage = await cacheUsage();
  const packs = await listPacks();
  const oldest = packs.reduce<number | null>((min, p) => (min === null || p.mtimeMs < min ? p.mtimeMs : min), null);

  if (io.json) {
    printJson({
      command: 'cache status',
      dir: cacheDir(),
      shoots: usage.packs,
      bytes: usage.bytes,
      max: usage.max,
      oldest: oldest === null ? null : new Date(oldest).toISOString(),
    });
    return;
  }
  printHuman(io, `${cacheDir()}`);
  printHuman(io, `${formatBytes(usage.bytes)} across ${usage.packs} shoot${usage.packs === 1 ? '' : 's'} (ceiling ${formatBytes(usage.max)})`);
  if (oldest !== null) printHuman(io, `oldest entry last written ${new Date(oldest).toISOString().slice(0, 10)}`);
  if (usage.packs === 0) {
    printHuman(io, 'Nothing cached yet — the first cull or rate fills it.');
  } else {
    printHuman(io, 'Holds derived numbers only (measurements, embeddings), never image data. `shoots cache clear` drops it all.');
  }
}

async function runClear(options: CacheOptions): Promise<void> {
  const io = makeIo(options);
  const before = await cacheUsage();
  const removed = await clearCache();
  logVerbose(io, `Removed ${removed} pack files from ${cacheDir()}`);
  if (io.json) {
    printJson({ command: 'cache clear', shoots: removed, freed: before.bytes });
    return;
  }
  printHuman(
    io,
    removed === 0
      ? 'Nothing to clear.'
      : `Cleared ${formatBytes(before.bytes)} across ${removed} shoot${removed === 1 ? '' : 's'}. The next run measures from scratch.`,
  );
}

async function runPrune(options: CacheOptions): Promise<void> {
  const io = makeIo(options);
  const result = await enforceCacheBudget();
  if (io.json) {
    printJson({ command: 'cache prune', evicted: result.evicted, freed: result.freed, bytes: result.bytes, max: cacheMaxBytes() });
    return;
  }
  printHuman(
    io,
    result.evicted === 0
      ? `Already under the ${formatBytes(cacheMaxBytes())} ceiling (${formatBytes(result.bytes)}).`
      : `Dropped ${result.evicted} shoot${result.evicted === 1 ? '' : 's'}, freeing ${formatBytes(result.freed)}; ${formatBytes(result.bytes)} left.`,
  );
}
