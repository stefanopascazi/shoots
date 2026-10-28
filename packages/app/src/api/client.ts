/** Typed calls to the local server. The session cookie rides along on every same-origin request. */
import type {
  AppInfo,
  AppSettings,
  Marks,
  MarksPatch,
  ResetRequest,
  BrowseResult,
  CleanupItem,
  CleanupPart,
  DevelopStatus,
  JobRequest,
  JobStatus,
  LibraryListing,
  LightroomError,
  RatingProfile,
} from '../contract.js';
import type { SentChange } from '../outbox.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('The app server is not reachable. Open the app again from Lightroom.', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status}).`, res.status);
  return data as T;
}

const q = (params: Record<string, string | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, v);
  const text = s.toString();
  return text ? `?${text}` : '';
};

export interface StartState {
  settings: AppSettings;
  /** The folder to open now: one named by the plug-in, else the last one when reopening is on. */
  startFolder: string | null;
  recent: string[];
}

export const api = {
  start: () => call<StartState>('GET', '/api/start'),
  saveSettings: (patch: Partial<AppSettings>) => call<AppSettings>('PUT', '/api/settings', patch),
  recentFolders: () => call<string[]>('GET', '/api/folders/recent'),
  sendToLightroom: (folder: string, recursive: boolean, paths?: string[]) =>
    call<{ queued: number }>('POST', '/api/outbox', { folder, recursive, paths }),
  sentState: (folder: string) => call<Record<string, SentChange>>('GET', `/api/outbox/state${q({ folder })}`),
  /** Replies with each photo's marks as they now stand; null when nothing is left set. */
  saveMarks: (marks: Record<string, MarksPatch>) => call<{ marks: Record<string, Marks | null> }>('PUT', '/api/marks', { marks }),
  /** Forgets the chosen parts in the app only; Lightroom keeps what was already sent to it. */
  reset: (request: ResetRequest) => call<{ reset: number }>('POST', '/api/reset', request),
  clearMemory: () => call<{ ok: boolean }>('DELETE', '/api/memory'),
  /** Bumps whenever Lightroom changed something the page shows; `following` once the plug-in reports the open folder. */
  sync: () => call<{ revision: number; following: boolean; lightroomError: LightroomError | null }>('GET', '/api/sync'),
  info: () => call<AppInfo>('GET', '/api/info'),
  profiles: () => call<RatingProfile[]>('GET', '/api/profiles'),
  heartbeat: () => call<{ ok: boolean; busy: boolean }>('POST', '/api/heartbeat'),
  browse: (path: string | null) => call<BrowseResult>('GET', `/api/browse${q({ path: path ?? undefined })}`),
  library: (folder: string, recursive: boolean) =>
    call<LibraryListing>('GET', `/api/library${q({ folder, recursive: recursive ? '1' : undefined })}`),
  startJob: (request: JobRequest) => call<JobStatus>('POST', '/api/jobs', request),
  job: (id: string) => call<JobStatus>('GET', `/api/jobs/${id}`),
  cancelJob: (id: string) => call<JobStatus>('DELETE', `/api/jobs/${id}`),
  /** The training or calibration running now, else the one that ended last; they outlive the server. */
  trainingJob: () => call<{ job: JobStatus | null }>('GET', '/api/jobs/training'),
  developStatus: () => call<DevelopStatus>('GET', '/api/develop/status'),
  cleanupPreview: () => call<{ items: CleanupItem[] }>('GET', '/api/cleanup'),
  /** Removes training output and job history; photos and Lightroom are untouched. */
  cleanup: (parts: CleanupPart[]) => call<{ removed: CleanupItem[] }>('POST', '/api/cleanup', { parts }),
};

export const thumbUrl = (path: string, width: number): string => `/api/thumb${q({ path, w: String(width) })}`;
