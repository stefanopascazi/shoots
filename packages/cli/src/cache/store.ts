/**
 * The derived-value cache: what a command already worked out about a
 * photograph, so the next one does not work it out again.
 *
 * WHAT LIVES HERE. Numbers only — a Laplacian measurement, a CLIP embedding, a
 * colour-feature vector. Never pixels. That is not a detail: the derived values
 * describing a 100k-frame catalog are a few hundred megabytes, its embedded
 * previews would be hundreds of gigabytes, and the expensive part was never the
 * bytes anyway. It is the decode and the inference, and those are what a hit
 * skips.
 *
 * WHAT IS CACHED VERSUS RECOMPUTED. Only the half of a computation that does not
 * depend on the run's parameters. `cull` caches the measurement and re-derives
 * the verdict, so changing `--threshold` and running again is free rather than
 * hours. The same split is what will let `rate` cache the embedding and re-derive
 * the stars per `--profile`.
 *
 * IDENTITY. A record is keyed by absolute path, and validated against the size
 * and mtime the scan already reported — no extra stat. Rewriting a photograph
 * changes its mtime and the entry is dropped. Renaming it outside `shoots`
 * orphans the entry, which costs a recomputation and nothing else: the failure
 * mode of this cache is always "measure it again", never "answer with the wrong
 * number".
 *
 * LAYOUT. One JSONL pack per *directory*, not per command target. Keying on the
 * folder the user happened to type would mean `cull shoot/` could not see what
 * `cull shoot/day1` measured — the same photographs, missed. Keying on each
 * file's own directory makes both runs agree, and keeps a command's reads down
 * to the handful of packs its scan actually spans.
 *
 * A pack is one file per shoot, deliberately: a hundred thousand small files is
 * a hundred thousand filesystem records, cluster slack on every one of them, and
 * a virus scanner's afternoon.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheShootPath, cacheDir } from '@shoots/core';
import { enforceCacheBudget, listPacks } from './budget.js';

/** The scan's own report on a file, and the whole of this cache's validation. */
export interface FileIdentity {
  size: number;
  mtimeMs: number;
}

/** One photograph's derived values, whatever produced them. */
interface CacheRecord {
  file: string;
  size: number;
  mtimeMs: number;
  /** Producer key (see producers.ts) → whatever that producer returns. */
  values: Record<string, unknown>;
}

/** Pack file for a directory: its name, plus a digest keeping same-named folders apart. */
export function packPathFor(directory: string): string {
  const resolved = path.resolve(directory);
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return cacheShootPath(`${path.basename(resolved) || 'root'}-${digest}`);
}

/** Set SHOOTS_CACHE=0 to run every command cold. */
function cacheEnabledByEnv(): boolean {
  const v = process.env.SHOOTS_CACHE;
  return v !== '0' && v !== 'false';
}

function parseRecord(line: string): CacheRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<CacheRecord>;
    if (
      typeof parsed?.file !== 'string' ||
      typeof parsed.size !== 'number' ||
      typeof parsed.mtimeMs !== 'number' ||
      typeof parsed.values !== 'object' ||
      parsed.values === null
    ) {
      return null;
    }
    return parsed as CacheRecord;
  } catch {
    // A half-written line from a run that died. Losing it costs a recomputation.
    return null;
  }
}

async function loadPack(packPath: string): Promise<Map<string, CacheRecord>> {
  const records = new Map<string, CacheRecord>();
  if (!existsSync(packPath)) return records;
  let text: string;
  try {
    text = await readFile(packPath, 'utf8');
  } catch {
    return records;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (record) records.set(record.file, record);
  }
  return records;
}

export interface CacheCounters {
  hits: number;
  misses: number;
  /** Values written this run (a miss that was then computed and stored). */
  writes: number;
  /** Records dropped because the photograph changed underneath them. */
  stale: number;
}

/**
 * The packs covering one command's set of files, open for reading and writing.
 *
 * A disabled cache is a working object that never hits and never writes, so no
 * call site needs to branch on whether caching is on.
 */
export class DerivedCache {
  private readonly dirty = new Set<string>();
  readonly counters: CacheCounters = { hits: 0, misses: 0, writes: 0, stale: 0 };

  private constructor(
    readonly enabled: boolean,
    /** Pack path → its records. */
    private readonly packs: Map<string, Map<string, CacheRecord>>,
  ) {}

  /**
   * Open the packs covering `files`. Reads only the directories those files sit
   * in, so a command pays for its own scope and not for the whole machine.
   */
  static async open(files: readonly string[], options: { enabled?: boolean } = {}): Promise<DerivedCache> {
    const enabled = (options.enabled ?? true) && cacheEnabledByEnv();
    if (!enabled) return new DerivedCache(false, new Map());

    const packPaths = new Set<string>();
    for (const file of files) packPaths.add(packPathFor(path.dirname(path.resolve(file))));

    const packs = new Map<string, Map<string, CacheRecord>>();
    for (const packPath of packPaths) packs.set(packPath, await loadPack(packPath));
    return new DerivedCache(true, packs);
  }

  /** A cache that never hits, for `--no-cache` and for tests that want cold runs. */
  static disabled(): DerivedCache {
    return new DerivedCache(false, new Map());
  }

  /**
   * The already-loaded pack a file belongs to, or null when it belongs to one
   * this instance never opened.
   *
   * Null, and never an empty pack invented on the spot. Loading is async and
   * this is not, so an invented pack would start out believing the directory has
   * no cached values at all — and {@link save} would then write that belief over
   * a real file, destroying every record the other shoot had. A file outside the
   * declared scope costs a recomputation instead, which is the failure this
   * cache is allowed to have.
   */
  private packFor(file: string): { key: string; records: Map<string, CacheRecord> } | null {
    const key = packPathFor(path.dirname(path.resolve(file)));
    const records = this.packs.get(key);
    return records ? { key, records } : null;
  }

  /**
   * The value `producer` last stored for this file, or undefined.
   *
   * `identity` is the size and mtime the scan reported. A record that disagrees
   * with it describes a photograph that has since changed, so it is dropped
   * whole — every producer's value for it is equally stale.
   */
  get<T>(file: string, producer: string, identity: FileIdentity): T | undefined {
    if (!this.enabled) return undefined;
    const pack = this.packFor(file);
    if (!pack) {
      this.counters.misses++;
      return undefined;
    }
    const key = path.resolve(file);
    const { key: packKey, records } = pack;
    const record = records.get(key);
    if (!record) {
      this.counters.misses++;
      return undefined;
    }
    if (record.size !== identity.size || record.mtimeMs !== identity.mtimeMs) {
      records.delete(key);
      this.dirty.add(packKey);
      this.counters.stale++;
      this.counters.misses++;
      return undefined;
    }
    const value = record.values[producer];
    if (value === undefined) {
      this.counters.misses++;
      return undefined;
    }
    this.counters.hits++;
    return value as T;
  }

  /** Store what `producer` worked out. Takes effect on {@link save}. */
  set(file: string, producer: string, identity: FileIdentity, value: unknown): void {
    if (!this.enabled) return;
    const pack = this.packFor(file);
    if (!pack) return;
    const key = path.resolve(file);
    const { key: packKey, records } = pack;
    const existing = records.get(key);
    // A record whose identity moved on keeps nothing: its other values described
    // the previous version of the photograph.
    const values =
      existing && existing.size === identity.size && existing.mtimeMs === identity.mtimeMs ? existing.values : {};
    records.set(key, { file: key, size: identity.size, mtimeMs: identity.mtimeMs, values: { ...values, [producer]: value } });
    this.dirty.add(packKey);
    this.counters.writes++;
  }

  /**
   * Persist the packs this run changed, then hold the cache to its ceiling.
   *
   * A run that only *read* still touches its packs, so a shoot in daily use does
   * not age into being the oldest thing on disk and get evicted.
   */
  async save(): Promise<void> {
    if (!this.enabled) return;
    for (const packPath of this.dirty) {
      const records = this.packs.get(packPath);
      if (!records || records.size === 0) {
        if (existsSync(packPath)) await rm(packPath, { force: true });
        continue;
      }
      await mkdir(path.dirname(packPath), { recursive: true });
      const body = [...records.values()].map((r) => JSON.stringify(r)).join('\n') + '\n';
      const tmp = `${packPath}.tmp-${process.pid}`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, packPath);
    }
    if (this.dirty.size === 0 && this.counters.hits > 0) {
      const now = new Date();
      for (const packPath of this.packs.keys()) {
        try {
          await utimes(packPath, now, now);
        } catch {
          // Nothing was written to it yet; there is nothing to age.
        }
      }
    }
    this.dirty.clear();
    // Never evict what this run is using — that would guarantee a cold next run.
    await enforceCacheBudget(new Set(this.packs.keys()));
  }
}

/** Drop every cached value on this machine. Returns how many packs went. */
export async function clearCache(): Promise<number> {
  const dir = cacheDir();
  if (!existsSync(dir)) return 0;
  const packs = await listPacks();
  let removed = 0;
  for (const pack of packs) {
    try {
      await rm(pack.path, { force: true });
      removed++;
    } catch {
      // Locked; leave it for the next attempt.
    }
  }
  return removed;
}
