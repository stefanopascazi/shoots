/**
 * The app's memory, in SQLite (~/.shoots/app/app.db): settings, recently opened
 * folders, the last cull and rate results per photograph, and the
 * photographer's keep/reject decisions.
 *
 * Results are stored against the file's size and modification time. A result
 * for a photograph that has since changed is not served: it describes pixels
 * that no longer exist.
 */
import type {
  AppSettings,
  CullResultItem,
  Decision,
  LibraryPhoto,
  LightroomChange,
  OutboxItem,
  RateResultItem,
  SentChange,
  StoredRate,
} from '@shoots/app';
import { openSqlite, type Db } from '@shoots/core';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  path      TEXT PRIMARY KEY,
  recursive INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('cull', 'rate')),
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  profile    TEXT,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (path, kind)
);
CREATE TABLE IF NOT EXISTS decisions (
  path       TEXT PRIMARY KEY,
  decision   TEXT NOT NULL CHECK (decision IN ('keep', 'reject')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  -- AUTOINCREMENT: a re-queued change must never reuse the id an earlier acknowledgement names.
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,
  rating     INTEGER,
  pick       INTEGER,
  state      TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'missing')),
  queued_at  TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state);
`;

export const DEFAULT_SETTINGS: AppSettings = {
  reopenLastFolder: true,
  lastFolder: null,
  recursive: false,
  profile: null,
  theme: 'system',
  filter: 'all',
  sort: 'name',
};

const FILTERS = ['all', 'keepers', 'rejected', 'review'] as const;
const SORTS = ['name', 'rating'] as const;
const THEMES = ['system', 'dark', 'light'] as const;

/** Keeps only known keys with values of the right shape; anything else is dropped. */
export function sanitizeSettings(patch: unknown): Partial<AppSettings> {
  if (!patch || typeof patch !== 'object') return {};
  const p = patch as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  if (typeof p.reopenLastFolder === 'boolean') out.reopenLastFolder = p.reopenLastFolder;
  if (typeof p.lastFolder === 'string' || p.lastFolder === null) out.lastFolder = p.lastFolder;
  if (typeof p.recursive === 'boolean') out.recursive = p.recursive;
  if ((typeof p.profile === 'string' && /^[\w.-]+$/.test(p.profile)) || p.profile === null) out.profile = p.profile;
  if (THEMES.includes(p.theme as never)) out.theme = p.theme as AppSettings['theme'];
  if (FILTERS.includes(p.filter as never)) out.filter = p.filter as AppSettings['filter'];
  if (SORTS.includes(p.sort as never)) out.sort = p.sort as AppSettings['sort'];
  return out;
}

const now = (): string => new Date().toISOString();

export type PhotoLookup = (file: string) => LibraryPhoto | undefined;

export interface StoredResults {
  cull: CullResultItem[];
  rate: StoredRate[];
  decisions: Record<string, Decision>;
  sent: Record<string, SentChange>;
}

interface OutboxRow {
  id: number;
  path: string;
  rating: number | null;
  pick: number | null;
  state: SentChange['state'];
}

const toChange = (r: OutboxRow): LightroomChange => ({
  path: r.path,
  rating: r.rating === null ? null : Number(r.rating),
  pick: r.pick === null ? null : (Number(r.pick) as LightroomChange['pick']),
});

export class AppStore {
  private constructor(private readonly db: Db) {}

  static async open(file: string): Promise<AppStore> {
    const db = await openSqlite(file);
    db.exec(SCHEMA);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run('schema_version', String(SCHEMA_VERSION));
    return new AppStore(db);
  }

  close(): void {
    this.db.close();
  }

  settings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const stored: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        stored[r.key] = JSON.parse(r.value);
      } catch {
        // A torn value falls back to its default.
      }
    }
    return { ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) };
  }

  updateSettings(patch: unknown): AppSettings {
    const clean = sanitizeSettings(patch);
    const put = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(clean)) put.run(k, JSON.stringify(v));
    return this.settings();
  }

  /** Records a folder as just opened, and makes it the one to reopen. */
  openedFolder(folder: string, recursive: boolean): void {
    this.db
      .prepare(
        `INSERT INTO folders (path, recursive, opened_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET recursive = excluded.recursive, opened_at = excluded.opened_at`,
      )
      .run(folder, recursive ? 1 : 0, now());
    this.updateSettings({ lastFolder: folder, recursive });
  }

  recentFolders(limit = 8): string[] {
    return (this.db.prepare('SELECT path FROM folders ORDER BY opened_at DESC LIMIT ?').all(limit) as { path: string }[]).map((r) => r.path);
  }

  /** Stores a job's per-photo results; `photoOf` maps a reported file to the listed photo and its identity. */
  saveResults(kind: 'cull', items: readonly CullResultItem[], photoOf: PhotoLookup): number;
  saveResults(kind: 'rate', items: readonly RateResultItem[], photoOf: PhotoLookup, profile: string): number;
  saveResults(
    kind: 'cull' | 'rate',
    items: readonly (CullResultItem | RateResultItem)[],
    photoOf: PhotoLookup,
    profile?: string,
  ): number {
    const put = this.db.prepare(
      `INSERT INTO results (path, kind, size, mtime_ms, profile, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path, kind) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
         profile = excluded.profile, data = excluded.data, created_at = excluded.created_at`,
    );
    let saved = 0;
    const at = now();
    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const photo = photoOf(item.file);
        if (!photo) continue;
        put.run(photo.path, kind, photo.size, photo.mtime, profile ?? null, JSON.stringify({ ...item, file: photo.path }), at);
        saved++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return saved;
  }

  /** What is known about these photographs, skipping results for files that changed since. */
  resultsFor(photos: readonly LibraryPhoto[]): StoredResults {
    const out: StoredResults = { cull: [], rate: [], decisions: {}, sent: {} };
    const getResult = this.db.prepare('SELECT kind, size, mtime_ms, profile, data FROM results WHERE path = ?');
    const getDecision = this.db.prepare('SELECT decision FROM decisions WHERE path = ?');
    const getSent = this.db.prepare('SELECT id, path, rating, pick, state FROM outbox WHERE path = ?');
    for (const p of photos) {
      for (const row of getResult.all(p.path) as { kind: string; size: number; mtime_ms: number; profile: string | null; data: string }[]) {
        if (Number(row.size) !== p.size || Number(row.mtime_ms) !== p.mtime) continue;
        const data = JSON.parse(row.data);
        if (row.kind === 'cull') out.cull.push(data as CullResultItem);
        else out.rate.push({ ...(data as RateResultItem), profile: row.profile ?? '' });
      }
      const d = getDecision.get(p.path) as { decision: Decision } | undefined;
      if (d) out.decisions[p.path] = d.decision;
      const s = getSent.get(p.path) as OutboxRow | undefined;
      if (s) out.sent[p.path] = { ...toChange(s), state: s.state };
    }
    return out;
  }

  /** What was sent for photos under `folder` — a cheap poll while a send is in flight. */
  sentUnder(folder: string): Record<string, SentChange> {
    const rows = this.db
      .prepare('SELECT id, path, rating, pick, state FROM outbox WHERE substr(path, 1, ?) = ?')
      .all(folder.length, folder) as OutboxRow[];
    return Object.fromEntries(rows.map((r) => [r.path, { ...toChange(r), state: r.state }]));
  }

  /**
   * Queues changes for the plug-in. A photo's earlier entry is replaced by a new
   * row with a new id, so an acknowledgement for the old one cannot settle it.
   */
  enqueue(changes: readonly LightroomChange[]): number {
    const drop = this.db.prepare('DELETE FROM outbox WHERE path = ?');
    const put = this.db.prepare("INSERT INTO outbox (path, rating, pick, state, queued_at) VALUES (?, ?, ?, 'pending', ?)");
    const at = now();
    this.db.exec('BEGIN');
    try {
      for (const c of changes) {
        drop.run(c.path);
        put.run(c.path, c.rating, c.pick, at);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return changes.length;
  }

  pendingCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get() as { n: number }).n);
  }

  /** The oldest changes waiting, for the plug-in to apply. */
  pending(limit = 500): OutboxItem[] {
    const rows = this.db.prepare("SELECT id, path, rating, pick, state FROM outbox WHERE state = 'pending' ORDER BY id LIMIT ?").all(limit) as OutboxRow[];
    return rows.map((r) => ({ id: Number(r.id), ...toChange(r) }));
  }

  /** Records what the plug-in did with the changes it collected. */
  settle(applied: readonly number[], missing: readonly number[]): number {
    const mark = this.db.prepare("UPDATE outbox SET state = ?, settled_at = ? WHERE id = ? AND state = 'pending'");
    const at = now();
    let n = 0;
    for (const id of applied) n += Number((mark.run('applied', at, id) as { changes?: number }).changes ?? 0);
    for (const id of missing) n += Number((mark.run('missing', at, id) as { changes?: number }).changes ?? 0);
    return n;
  }

  setDecision(path: string, decision: Decision | null): void {
    if (decision) {
      this.db
        .prepare('INSERT INTO decisions (path, decision, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at')
        .run(path, decision, now());
    } else {
      this.db.prepare('DELETE FROM decisions WHERE path = ?').run(path);
    }
  }
}
