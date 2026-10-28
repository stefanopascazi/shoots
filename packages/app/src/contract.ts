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

export interface LibraryListing {
  folder: string;
  recursive: boolean;
  photos: LibraryPhoto[];
}

export interface RatingProfile {
  name: string;
  learned: boolean;
}

export type JobKind = 'cull' | 'rate' | 'doctor';
export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRequest {
  kind: JobKind;
  /** cull/rate: the folder as listed, so the job sees exactly the photos on screen. */
  folder?: string;
  recursive?: boolean;
  profile?: string;
}

export interface JobProgress {
  label: string;
  done?: number;
  total?: number;
  detail?: string;
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
