/**
 * Keeping the derived cache from growing without anyone noticing.
 *
 * The cache holds numbers, not pixels, so it is small in the way that matters —
 * a few kilobytes per photograph against a RAW's tens of megabytes. Small is not
 * the same as bounded, though, and a tool that quietly fills somebody's disk has
 * no business defaulting to on. So there is a ceiling, and crossing it drops
 * whole shoots, oldest first.
 *
 * Eviction is per *shoot pack*, never per record. A pack is one file: dropping
 * it is one unlink and it leaves the cache coherent, whereas rewriting packs to
 * expire individual records would cost more than the misses it saves.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { cacheDir } from '@shoots/core';

/** Default ceiling: ~380k photographs' worth of derived values. */
export const DEFAULT_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;
const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/**
 * Parse a size budget: plain bytes, or a `512MB` / `2GB` spelling. Anything
 * unparseable falls back to the default rather than failing a command — a
 * mistyped budget should not stop a cull.
 */
export function parseCacheMax(value: string | undefined): number {
  if (!value) return DEFAULT_CACHE_MAX_BYTES;
  const m = SIZE_RE.exec(value.trim());
  if (!m) return DEFAULT_CACHE_MAX_BYTES;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CACHE_MAX_BYTES;
  return Math.round(n * (UNITS[(m[2] ?? 'b').toLowerCase()] ?? 1));
}

/** The ceiling in force, from SHOOTS_CACHE_MAX. Zero means "evict everything". */
export function cacheMaxBytes(): number {
  return parseCacheMax(process.env.SHOOTS_CACHE_MAX);
}

export interface CachePack {
  path: string;
  bytes: number;
  /** Last write, which is what "least recently used" is judged on. */
  mtimeMs: number;
}

/** Every pack currently on this machine, with its size and age. */
export async function listPacks(): Promise<CachePack[]> {
  const dir = cacheDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const packs: CachePack[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, entry.name);
    try {
      const info = await stat(full);
      packs.push({ path: full, bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // vanished between the listing and the stat — nothing to account for
    }
  }
  return packs;
}

export interface CacheUsage {
  packs: number;
  bytes: number;
  max: number;
}

/** What the cache currently occupies, against what it is allowed. */
export async function cacheUsage(): Promise<CacheUsage> {
  const packs = await listPacks();
  return { packs: packs.length, bytes: packs.reduce((sum, p) => sum + p.bytes, 0), max: cacheMaxBytes() };
}

export interface EvictionResult {
  evicted: number;
  freed: number;
  /** Total after eviction. */
  bytes: number;
}

/**
 * Drop the oldest packs until the cache fits under its ceiling.
 *
 * `keep` names packs the caller is still using — evicting the one just written
 * would turn every run into a cold one, which is the opposite of the point.
 * A single pack larger than the whole budget is therefore left alone, and the
 * cache simply sits over its ceiling rather than destroying the work in hand.
 */
export async function enforceCacheBudget(keep: ReadonlySet<string> = new Set()): Promise<EvictionResult> {
  const max = cacheMaxBytes();
  const packs = await listPacks();
  let bytes = packs.reduce((sum, p) => sum + p.bytes, 0);
  if (bytes <= max) return { evicted: 0, freed: 0, bytes };

  // Oldest first: a shoot nobody has touched in months is the cheapest to lose.
  const candidates = packs
    .filter((p) => !keep.has(path.resolve(p.path)))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let evicted = 0;
  let freed = 0;
  for (const pack of candidates) {
    if (bytes <= max) break;
    try {
      await rm(pack.path, { force: true });
      bytes -= pack.bytes;
      freed += pack.bytes;
      evicted++;
    } catch {
      // Locked by another process; the next run will try again.
    }
  }
  return { evicted, freed, bytes };
}
