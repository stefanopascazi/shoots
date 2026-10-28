/**
 * The app's memory, in SQLite (~/.shoots/app/app.db): settings, recently opened
 * folders, the last cull and rate results per photograph, the photographer's
 * own marks (flag, stars, colour label) and the outbox to Lightroom.
 *
 * Forgetting (a reset, clearing the memory) happens here and only here: it never
 * reaches Lightroom, which keeps whatever was already sent to it.
 *
 * Results are stored against the file's size and modification time. A result
 * for a photograph that has since changed is not served: it describes pixels
 * that no longer exist.
 */
import {
  applyMarksPatch,
  type AppSettings,
  type ColorLabel,
  type CullResultItem,
  type LibraryPhoto,
  type LightroomChange,
  type Marks,
  type MarksPatch,
  type OutboxItem,
  type RateResultItem,
  type ResetPart,
  type SentChange,
  type StoredRate,
} from '@shoots/app';
import { openSqlite, type Db } from '@shoots/core';

export const SCHEMA_VERSION = 2;

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
CREATE TABLE IF NOT EXISTS marks (
  path       TEXT PRIMARY KEY,
  flag       TEXT CHECK (flag IN ('pick', 'reject', 'unflagged')),
  stars      INTEGER CHECK (stars BETWEEN 0 AND 5),
  label      TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  -- AUTOINCREMENT: a re-queued change must never reuse the id an earlier acknowledgement names.
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,
  rating     INTEGER,
  pick       INTEGER,
  label      TEXT,
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
  labelFilter: 'any',
  sort: 'name',
};

const FILTERS = ['all', 'picks', 'keepers', 'rejected', 'review'] as const;
const SORTS = ['name', 'rating'] as const;
const THEMES = ['system', 'dark', 'light'] as const;
const LABEL_FILTERS = ['any', 'red', 'yellow', 'green', 'blue', 'purple', 'none'] as const;

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
  if (LABEL_FILTERS.includes(p.labelFilter as never)) out.labelFilter = p.labelFilter as AppSettings['labelFilter'];
  if (SORTS.includes(p.sort as never)) out.sort = p.sort as AppSettings['sort'];
  return out;
}

const now = (): string => new Date().toISOString();

export type PhotoLookup = (file: string) => LibraryPhoto | undefined;

export interface StoredResults {
  cull: CullResultItem[];
  rate: StoredRate[];
  marks: Record<string, Marks>;
  sent: Record<string, SentChange>;
}

interface OutboxRow {
  id: number;
  path: string;
  rating: number | null;
  pick: number | null;
  label: string | null;
  state: SentChange['state'];
}

interface MarksRow {
  flag: Marks['flag'] | null;
  stars: number | null;
  label: ColorLabel | null;
}

const toChange = (r: OutboxRow): LightroomChange => ({
  path: r.path,
  rating: r.rating === null ? null : Number(r.rating),
  pick: r.pick === null ? null : (Number(r.pick) as LightroomChange['pick']),
  label: (r.label as ColorLabel | null) ?? null,
});

const toSent = (r: OutboxRow): SentChange => ({ ...toChange(r), state: r.state });

const toMarks = (r: MarksRow): Marks => ({
  ...(r.flag ? { flag: r.flag } : {}),
  ...(r.stars !== null ? { stars: Number(r.stars) } : {}),
  ...(r.label ? { label: r.label } : {}),
});

const OUTBOX_COLUMNS = 'id, path, rating, pick, label, state';

/** Brings a database written by an earlier version up to this schema. */
function migrate(db: Db): void {
  const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? SCHEMA_VERSION);
  if (version < 2) {
    // v1 kept keep/reject decisions; they become flags. "Keep" was the photographer keeping a frame: a pick.
    const hasDecisions = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decisions'").get() as unknown) !== undefined;
    if (hasDecisions) {
      db.exec(`INSERT OR IGNORE INTO marks (path, flag, updated_at)
               SELECT path, CASE decision WHEN 'keep' THEN 'pick' ELSE 'reject' END, updated_at FROM decisions`);
      db.exec('DROP TABLE decisions');
    }
    const columns = (db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('label')) db.exec('ALTER TABLE outbox ADD COLUMN label TEXT');
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
}

export class AppStore {
  private constructor(private readonly db: Db) {}

  static async open(file: string): Promise<AppStore> {
    const db = await openSqlite(file);
    db.exec(SCHEMA);
    migrate(db);
    return new AppStore(db);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = work();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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
    const at = now();
    return this.transaction(() => {
      let saved = 0;
      for (const item of items) {
        const photo = photoOf(item.file);
        if (!photo) continue;
        put.run(photo.path, kind, photo.size, photo.mtime, profile ?? null, JSON.stringify({ ...item, file: photo.path }), at);
        saved++;
      }
      return saved;
    });
  }

  /** What is known about these photographs, skipping results for files that changed since. */
  resultsFor(photos: readonly LibraryPhoto[]): StoredResults {
    const out: StoredResults = { cull: [], rate: [], marks: {}, sent: {} };
    const getResult = this.db.prepare('SELECT kind, size, mtime_ms, profile, data FROM results WHERE path = ?');
    const getMarks = this.db.prepare('SELECT flag, stars, label FROM marks WHERE path = ?');
    const getSent = this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE path = ?`);
    for (const p of photos) {
      for (const row of getResult.all(p.path) as { kind: string; size: number; mtime_ms: number; profile: string | null; data: string }[]) {
        if (Number(row.size) !== p.size || Number(row.mtime_ms) !== p.mtime) continue;
        const data = JSON.parse(row.data);
        if (row.kind === 'cull') out.cull.push(data as CullResultItem);
        else out.rate.push({ ...(data as RateResultItem), profile: row.profile ?? '' });
      }
      const m = getMarks.get(p.path) as MarksRow | undefined;
      if (m) out.marks[p.path] = toMarks(m);
      const s = getSent.get(p.path) as OutboxRow | undefined;
      if (s) out.sent[p.path] = toSent(s);
    }
    return out;
  }

  marksOf(path: string): Marks | undefined {
    const row = this.db.prepare('SELECT flag, stars, label FROM marks WHERE path = ?').get(path) as MarksRow | undefined;
    return row ? toMarks(row) : undefined;
  }

  /** Applies a patch to a photo's marks; a photo left with nothing set loses its row. */
  setMarks(path: string, patch: MarksPatch): Marks | undefined {
    const next = applyMarksPatch(this.marksOf(path), patch);
    if (!next) {
      this.db.prepare('DELETE FROM marks WHERE path = ?').run(path);
      return undefined;
    }
    this.db
      .prepare(
        `INSERT INTO marks (path, flag, stars, label, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET flag = excluded.flag, stars = excluded.stars, label = excluded.label, updated_at = excluded.updated_at`,
      )
      .run(path, next.flag ?? null, next.stars ?? null, next.label ?? null, now());
    return next;
  }

  /** What was sent for photos under `folder` — a cheap poll while a send is in flight. */
  sentUnder(folder: string): Record<string, SentChange> {
    const rows = this.db
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE substr(path, 1, ?) = ?`)
      .all(folder.length, folder) as OutboxRow[];
    return Object.fromEntries(rows.map((r) => [r.path, toSent(r)]));
  }

  /**
   * Queues changes for the plug-in. A photo's earlier entry is replaced by a new
   * row with a new id, so an acknowledgement for the old one cannot settle it.
   */
  enqueue(changes: readonly LightroomChange[]): number {
    const drop = this.db.prepare('DELETE FROM outbox WHERE path = ?');
    const put = this.db.prepare("INSERT INTO outbox (path, rating, pick, label, state, queued_at) VALUES (?, ?, ?, ?, 'pending', ?)");
    const at = now();
    return this.transaction(() => {
      for (const c of changes) {
        drop.run(c.path);
        put.run(c.path, c.rating, c.pick, c.label, at);
      }
      return changes.length;
    });
  }

  pendingCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get() as { n: number }).n);
  }

  /** The oldest changes waiting, for the plug-in to apply. */
  pending(limit = 500): OutboxItem[] {
    const rows = this.db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE state = 'pending' ORDER BY id LIMIT ?`).all(limit) as OutboxRow[];
    return rows.map((r) => ({ id: Number(r.id), ...toChange(r) }));
  }

  /** Records what the plug-in did with the changes it collected. */
  settle(applied: readonly number[], missing: readonly number[]): number {
    const mark = this.db.prepare("UPDATE outbox SET state = ?, settled_at = ? WHERE id = ? AND state = 'pending'");
    const at = now();
    return this.transaction(() => {
      let n = 0;
      for (const id of applied) n += Number((mark.run('applied', at, id) as { changes?: number }).changes ?? 0);
      for (const id of missing) n += Number((mark.run('missing', at, id) as { changes?: number }).changes ?? 0);
      return n;
    });
  }

  /**
   * Forgets the chosen parts for these photos, in the app only: the blur check,
   * shoots' ratings, the photographer's marks, the send history (which also
   * withdraws a send not collected yet). Lightroom is not touched.
   */
  reset(paths: readonly string[], parts: readonly ResetPart[]): number {
    const sql: Record<ResetPart, string> = {
      cull: "DELETE FROM results WHERE path = ? AND kind = 'cull'",
      rate: "DELETE FROM results WHERE path = ? AND kind = 'rate'",
      marks: 'DELETE FROM marks WHERE path = ?',
      sent: 'DELETE FROM outbox WHERE path = ?',
    };
    const statements = [...new Set(parts)].map((p) => this.db.prepare(sql[p]));
    return this.transaction(() => {
      for (const path of paths) for (const st of statements) st.run(path);
      return paths.length;
    });
  }

  /** Forgets everything: settings, folders, results, marks and the outbox. Lightroom is not touched. */
  clearAll(): void {
    this.transaction(() => {
      for (const table of ['settings', 'folders', 'results', 'marks', 'outbox']) this.db.exec(`DELETE FROM ${table}`);
    });
  }
}
