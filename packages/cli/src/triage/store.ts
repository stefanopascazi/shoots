/**
 * The triage store: where `cull` and `rate` leave their marks until a sidecar
 * writer picks them up.
 *
 * Nothing here goes near the photographer's folder. The rule the store exists to
 * enforce is that only the write path (`develop edit`, `triage apply`) creates a
 * sidecar; everything before it records a fragment under `~/.shoots/triage` and
 * lets that fragment be reconstructed later, in whatever vocabulary the target
 * editor speaks.
 *
 * IDENTITY. A record is keyed by absolute path. That is deterministic and costs
 * nothing, but a path is not the photograph: rename or move the file and the key
 * is stale. Rather than pay a content hash on every RAW, the store exposes
 * {@link moveMarks} and the commands that relocate files (`cull --dest`,
 * `rename`) call it. `size`/`mtimeMs` are carried as a cheap tripwire for the
 * case nobody told us about.
 *
 * LAYOUT. One JSONL file per shoot, so a shoot's marks can be inspected or
 * deleted on their own. Reads, however, index across *every* shoot file: culling
 * `shoot/day1` and developing `shoot/` are the same photographs, and keying the
 * lookup on the folder the user happened to type would silently lose the marks.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { triageHome, triageShootPath } from '@shoots/core';
import {
  mergeMarks,
  parseRecord,
  type MarkProvenance,
  type MarkSource,
  type TriageMarks,
  type TriageRecord,
} from './schema.js';

/**
 * Store file for a shoot: the folder's name plus a short digest of its absolute
 * path. The name alone is what a human recognises, but `2026-07-19` is the most
 * reusable folder name in photography — the digest keeps two of them apart.
 */
export function storePathFor(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return triageShootPath(`${path.basename(resolved)}-${digest}`);
}

/** Write `records` to `storePath` atomically (temp + rename), or remove it when empty. */
async function persist(storePath: string, records: Map<string, TriageRecord>): Promise<void> {
  if (records.size === 0) {
    if (existsSync(storePath)) await rm(storePath, { force: true });
    return;
  }
  await mkdir(path.dirname(storePath), { recursive: true });
  const body = [...records.values()].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const tmp = `${storePath}.tmp-${process.pid}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, storePath);
}

/** Load one store file. A missing file is an empty store, not an error. */
async function loadFile(storePath: string): Promise<Map<string, TriageRecord>> {
  const records = new Map<string, TriageRecord>();
  if (!existsSync(storePath)) return records;
  const text = await readFile(storePath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (record) records.set(record.file, record);
  }
  return records;
}

/** Every store file currently on this machine. */
async function storeFiles(): Promise<string[]> {
  const home = triageHome();
  if (!existsSync(home)) return [];
  const entries = await readdir(home, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(home, e.name));
}

/**
 * Marks for one shoot, open for writing.
 *
 * Read-modify-write on a whole file rather than an append log: a shoot is
 * thousands of small records at most, and a single rewrite keeps re-marking the
 * same file (cull, then rate) from growing duplicates that every reader would
 * then have to reconcile.
 */
export class TriageStore {
  private constructor(
    readonly storePath: string,
    private readonly records: Map<string, TriageRecord>,
  ) {}

  static async open(targetPath: string): Promise<TriageStore> {
    const storePath = storePathFor(targetPath);
    return new TriageStore(storePath, await loadFile(storePath));
  }

  /**
   * Record what a producer decided about one file. Marks merge field by field,
   * so `rate` adding stars does not erase the rejection `cull` found.
   */
  async mark(file: string, marks: TriageMarks, source: MarkSource, provenance: Omit<MarkProvenance, 'at'>): Promise<void> {
    const key = path.resolve(file);
    const existing = this.records.get(key);
    let size = existing?.size ?? 0;
    let mtimeMs = existing?.mtimeMs ?? 0;
    try {
      const info = await stat(key);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      // The file vanished between analysis and marking; keep whatever we had.
    }
    this.records.set(key, {
      file: key,
      size,
      mtimeMs,
      marks: mergeMarks(existing?.marks ?? {}, marks),
      sources: { ...existing?.sources, [source]: { ...provenance, at: new Date().toISOString() } },
      // Re-marking an already-applied file makes it pending again: the
      // photographer changed their mind after the sidecar was written.
    });
  }

  /** Number of records held. */
  get size(): number {
    return this.records.size;
  }

  async save(): Promise<void> {
    await persist(this.storePath, this.records);
  }
}

/**
 * Marks for a set of files, looked up across every shoot on this machine.
 *
 * Files with no mark are simply absent. Applied records are included — callers
 * decide whether a mark that already reached a sidecar should be rewritten.
 */
export async function readMarks(files: readonly string[]): Promise<Map<string, TriageRecord>> {
  const wanted = new Set(files.map((f) => path.resolve(f)));
  const found = new Map<string, TriageRecord>();
  for (const storePath of await storeFiles()) {
    for (const [key, record] of await loadFile(storePath)) {
      if (wanted.has(key)) found.set(key, record);
    }
  }
  return found;
}

/**
 * Pending marks for photographs living under `targetPath`.
 *
 * Answers "is anything waiting for this shoot?" by reading the store alone —
 * a handful of small files — instead of walking the catalog to ask each
 * photograph whether it has a mark. The difference does not show on a shoot
 * folder and is the whole answer on a drive root, where the walk is minutes of
 * silence and the store is milliseconds.
 */
export async function countPendingUnder(targetPath: string): Promise<number> {
  const root = path.resolve(targetPath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  let pending = 0;
  for (const storePath of await storeFiles()) {
    for (const [key, record] of await loadFile(storePath)) {
      if (record.applied) continue;
      if (key === root || key.startsWith(prefix)) pending++;
    }
  }
  return pending;
}

/** Every record on this machine, grouped by the store file holding it. */
export async function readAllMarks(): Promise<Map<string, Map<string, TriageRecord>>> {
  const all = new Map<string, Map<string, TriageRecord>>();
  for (const storePath of await storeFiles()) all.set(storePath, await loadFile(storePath));
  return all;
}

/**
 * Follow a file that moved, so its marks move with it. Called by whoever
 * relocates or renames — see the identity note at the top of this file.
 * Silently does nothing when the file carried no marks.
 */
export async function moveMarks(from: string, to: string): Promise<void> {
  const fromKey = path.resolve(from);
  const toKey = path.resolve(to);
  if (fromKey === toKey) return;
  for (const storePath of await storeFiles()) {
    const records = await loadFile(storePath);
    const record = records.get(fromKey);
    if (!record) continue;
    records.delete(fromKey);
    records.set(toKey, { ...record, file: toKey });
    await persist(storePath, records);
    return;
  }
}

/**
 * Soft consume: mark records as applied rather than deleting them.
 *
 * A hard delete would be tidy right up to the first time a run dies halfway, or
 * the photographer discards a sidecar and wants it back — at which point the
 * decision that produced it is gone for good. Nothing is left in the
 * photographer's folder either way; `triage clean` purges what is applied.
 */
export async function consumeMarks(applied: ReadonlyMap<string, string>): Promise<number> {
  if (applied.size === 0) return 0;
  const at = new Date().toISOString();
  let count = 0;
  for (const storePath of await storeFiles()) {
    const records = await loadFile(storePath);
    let touched = false;
    for (const [file, sidecar] of applied) {
      const key = path.resolve(file);
      const record = records.get(key);
      if (!record) continue;
      records.set(key, { ...record, applied: { at, sidecar } });
      touched = true;
      count++;
    }
    if (touched) await persist(storePath, records);
  }
  return count;
}

export interface PurgeResult {
  /** Applied records dropped. */
  applied: number;
  /** Pending records whose file no longer exists. */
  orphaned: number;
}

/**
 * Drop what is no longer useful: everything already written to a sidecar, and
 * pending marks whose photograph has gone (moved by something that did not tell
 * us, or deleted). `dryRun` counts without writing.
 */
export async function purgeMarks(options: { orphans?: boolean; dryRun?: boolean } = {}): Promise<PurgeResult> {
  const result: PurgeResult = { applied: 0, orphaned: 0 };
  for (const storePath of await storeFiles()) {
    const records = await loadFile(storePath);
    const keep = new Map<string, TriageRecord>();
    for (const [key, record] of records) {
      if (record.applied) {
        result.applied++;
        continue;
      }
      if (options.orphans && !existsSync(key)) {
        result.orphaned++;
        continue;
      }
      keep.set(key, record);
    }
    if (!options.dryRun && keep.size !== records.size) await persist(storePath, keep);
  }
  return result;
}
