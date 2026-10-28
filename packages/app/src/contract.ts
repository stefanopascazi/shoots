import type { LightroomChange, SentChange } from './outbox.js';

/**
 * The JSON contract between the local app server (in @shoots/cli) and the
 * browser client. Types only: imported by both sides, never bundled as code.
 */

export interface AppInfo {
  version: string;
  platform: string;
  home: string;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  /** null lists the roots (drives on Windows). */
  path: string | null;
  parent: string | null;
  dirs: DirEntry[];
  /** Images directly inside `path`. */
  images: number;
}

export type PhotoKind = 'raw' | 'processed';

export interface LibraryPhoto {
  path: string;
  name: string;
  kind: PhotoKind;
  size: number;
  mtime: number;
}

/** Lightroom's flags: pick (P), reject (X), unflagged (U). */
export type Flag = 'pick' | 'reject' | 'unflagged';

/** Lightroom's colour labels, by the names its SDK uses; `none` clears the label. */
export type ColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | 'none';

/**
 * What the photographer set by hand. Each field overrides what shoots proposed
 * (the cull verdict, the rating); an absent field leaves the proposal in force.
 */
export interface Marks {
  flag?: Flag;
  stars?: number;
  label?: ColorLabel;
}

/** A change to marks: a value sets the field, null hands it back to shoots. */
export type MarksPatch = { [K in keyof Marks]?: Marks[K] | null };

export interface LibraryListing {
  folder: string;
  recursive: boolean;
  photos: LibraryPhoto[];
  /** What earlier runs found, for photographs unchanged since. */
  cull: CullResultItem[];
  rate: StoredRate[];
  /** The photographer's own marks, by path. */
  marks: Record<string, Marks>;
  /** What was last sent to Lightroom for each photo, and what became of it. */
  sent: Record<string, SentChange>;
}

/** A photo as the Lightroom catalog holds it, read back by the plug-in. */
export interface LightroomState {
  path: string;
  /** 0 when unrated. */
  rating: number;
  pick: -1 | 0 | 1;
  label: ColorLabel;
}

/** What the plug-in should follow: the folder open in the app. */
export interface SyncWatch {
  folder: string;
  recursive: boolean;
}

/** A change waiting for the plug-in, as it collects it. */
export interface OutboxItem extends LightroomChange {
  id: number;
}

/**
 * What a reset forgets, each on its own: the blur check, shoots' ratings, the
 * photographer's marks, the history of what was sent to Lightroom.
 */
export type ResetPart = 'cull' | 'rate' | 'marks' | 'sent';

/** A reset only forgets, in the app's own database: Lightroom keeps whatever was already sent to it. */
export interface ResetRequest {
  folder: string;
  recursive?: boolean;
  /** Only these photos; the whole folder when absent. */
  paths?: string[];
  parts: ResetPart[];
}

export interface AppSettings {
  /** Open the last folder again when the app starts. */
  reopenLastFolder: boolean;
  lastFolder: string | null;
  recursive: boolean;
  /** Rating profile last used; null picks the default. */
  profile: string | null;
  theme: 'system' | 'dark' | 'light';
  filter: 'all' | 'picks' | 'keepers' | 'rejected' | 'review';
  /** Show only photos with this colour label; `any` shows all. */
  labelFilter: ColorLabel | 'any';
  sort: 'name' | 'rating';
}

export interface RatingProfile {
  name: string;
  learned: boolean;
}

/** train and calibrate run detached: they finish even when Lightroom closes and the app stops. */
export type JobKind = 'cull' | 'rate' | 'doctor' | 'train' | 'calibrate';
export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRequest {
  kind: JobKind;
  /** cull/rate: the folder as listed, so the job sees exactly the photos on screen; train: the folder to learn from. */
  folder?: string;
  recursive?: boolean;
  profile?: string;
}

export interface JobProgress {
  label: string;
  done?: number;
  total?: number;
  detail?: string;
  /** A page the job serves and waits on, such as the calibration review. */
  url?: string;
}

/** A training waiting for Lightroom: the plug-in exports this folder's develop settings for it. */
export interface CatalogRequest {
  job: string;
  folder: string;
  recursive: boolean;
}

/** What `develop status --json` reports about the trained profile; the parts the app shows. */
export interface DevelopStatus {
  command: 'develop-status';
  dataset: { path: string; exists: boolean; bytes: number };
  profile: {
    path: string;
    exists?: false;
    name?: string;
    trainedAt?: string;
    stats?: { edited: number; color: number; bw: number };
    calibration?: { at: string; stale: boolean } | null;
  };
}

export interface JobStatus {
  id: string;
  kind: JobKind;
  state: JobState;
  progress?: JobProgress;
  /** The command's own --json report. */
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface FocusMap {
  cols: number;
  rows: number;
  /** Sharpness per tile, row-major. */
  tiles: number[];
}

export interface CullResultItem {
  file: string;
  score: number;
  focusPeak: number;
  verdict: 'sharp' | 'blurry';
  /** Soft overall but sharp somewhere: shallow depth of field, kept by the focus rescue. */
  rescued: boolean;
  aperture: number | null;
  focusMap?: FocusMap;
}

export interface CullReport {
  command: 'cull';
  results: CullResultItem[];
  summary: { total: number; sharp: number; blurry: number; rescued: number; failed: number };
}

export interface RateResultItem {
  file: string;
  stars: number;
  focus: number;
  aesthetic: number;
  keywords: string[];
}

/** A stored rating, with the profile that produced it. */
export interface StoredRate extends RateResultItem {
  profile: string;
}

export interface RateReport {
  command: 'rate';
  profile: string;
  results: RateResultItem[];
  summary: { total: number; rated: number; failed: number };
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorReport {
  command: 'doctor';
  checks: Array<{ name: string; status: CheckStatus; detail: string }>;
  summary: { failed: number; warned: number; total: number };
}
