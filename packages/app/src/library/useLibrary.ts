import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../api/client.js';
import type { CullResultItem, LibraryListing, MarksPatch, RateResultItem, ResetPart, StoredRate } from '../contract.js';
import type { SentChange } from '../outbox.js';
import { clearLegacyDecisions, loadLegacyDecisions, withMarks } from './marks.js';
import { mergeResults, type MarksByPath, type PhotoView } from './model.js';

export interface LibraryState {
  folder: string | undefined;
  recursive: boolean;
  listing: LibraryListing | undefined;
  photos: PhotoView[];
  loading: boolean;
  error: string | undefined;
  recent: string[];
  /** The profile the shown ratings came from, when they are stored ones. */
  ratedWith: string | undefined;
  open: (folder: string) => void;
  setRecursive: (recursive: boolean) => void;
  setCull: (results: CullResultItem[]) => void;
  setRate: (results: RateResultItem[], profile: string) => void;
  /** Sets a photo's flag, stars or label by hand; a null field hands it back to shoots. */
  mark: (path: string, patch: MarksPatch) => void;
  /** Forgets the chosen parts, for these photos or the whole folder, in the app only. */
  reset: (parts: ResetPart[], paths?: string[]) => Promise<void>;
  /** Queues what is not in Lightroom yet; resolves with how many photos were queued. */
  send: (paths?: string[]) => Promise<number>;
  /** Whether the plug-in is reading this folder back from the catalog. */
  following: boolean;
}

export interface LibraryStart {
  folder: string | null;
  recursive: boolean;
  recent: string[];
}

/** How often to look again while the plug-in has not collected a send. */
const SEND_POLL_MS = 2000;
/** How often to ask whether Lightroom changed something. */
const SYNC_POLL_MS = 3000;

/** The open folder, its photos, and everything known about them — stored by the server. */
export function useLibrary(caseInsensitive: boolean, start: LibraryStart): LibraryState {
  const [recent, setRecent] = useState(start.recent);
  const [folder, setFolder] = useState<string | undefined>(start.folder ?? undefined);
  const [recursive, setRecursive] = useState(start.recursive);
  const [listing, setListing] = useState<LibraryListing>();
  const [cull, setCull] = useState<CullResultItem[]>([]);
  const [rate, setRateItems] = useState<StoredRate[]>([]);
  const [marks, setMarks] = useState<MarksByPath>({});
  const [sent, setSent] = useState<Record<string, SentChange>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // Bumped to list the folder again, after a reset or a change made in Lightroom.
  const [generation, setGeneration] = useState(0);
  const [following, setFollowing] = useState(false);

  useEffect(() => {
    if (!folder) return;
    let alive = true;
    setLoading(true);
    setError(undefined);
    api.library(folder, recursive).then(
      async (l) => {
        if (!alive) return;
        // Decisions made before the database existed lived in this browser: hand them over once.
        let legacy = {};
        const old = loadLegacyDecisions(l.folder);
        if (Object.keys(old).length) {
          legacy = await api.saveMarks(old).then(
            (r) => {
              clearLegacyDecisions(l.folder);
              return Object.fromEntries(Object.entries(r.marks).filter(([, m]) => m));
            },
            () => ({}),
          );
        }
        setListing(l);
        setCull(l.cull);
        setRateItems(l.rate);
        setMarks({ ...l.marks, ...legacy });
        setSent(l.sent);
        setLoading(false);
        api.recentFolders().then((r) => alive && setRecent(r), () => {});
      },
      (e: Error) => {
        if (!alive) return;
        setListing(undefined);
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [folder, recursive, generation]);

  const open = useCallback((next: string) => {
    setCull([]);
    setRateItems([]);
    setFolder(next);
  }, []);

  const setRate = useCallback((results: RateResultItem[], profile: string) => {
    setRateItems(results.map((r) => ({ ...r, profile })));
  }, []);

  const mark = useCallback((path: string, patch: MarksPatch) => {
    setMarks((m) => withMarks(m, path, patch));
    void api.saveMarks({ [path]: patch }).catch(() => {});
  }, []);

  const reset = useCallback(
    async (parts: ResetPart[], paths?: string[]) => {
      if (!listing) return;
      await api.reset({ folder: listing.folder, recursive: listing.recursive, paths, parts });
      setGeneration((g) => g + 1);
    },
    [listing],
  );

  const send = useCallback(
    async (paths?: string[]) => {
      if (!listing) return 0;
      const { queued } = await api.sendToLightroom(listing.folder, listing.recursive, paths);
      setSent(await api.sentState(listing.folder));
      return queued;
    },
    [listing],
  );

  const waiting = useMemo(() => Object.values(sent).some((s) => s.state === 'pending'), [sent]);

  // While something waits for the plug-in, look again until it has been collected.
  useEffect(() => {
    if (!listing || !waiting) return;
    let alive = true;
    const timer = setInterval(() => {
      api.sentState(listing.folder).then((s) => alive && setSent(s), () => {});
    }, SEND_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [listing, waiting]);

  // Changes made in Lightroom reach the page: when the server says something changed, list again.
  useEffect(() => {
    if (!listing) return;
    let alive = true;
    let seen: number | undefined;
    const check = () =>
      api.sync().then(
        (s) => {
          if (!alive) return;
          setFollowing(s.following);
          if (seen !== undefined && s.revision !== seen) setGeneration((g) => g + 1);
          seen = s.revision;
        },
        () => {},
      );
    void check();
    const timer = setInterval(check, SYNC_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [listing?.folder, listing?.recursive]);

  const photos = useMemo(
    () => (listing ? mergeResults(listing.photos, cull, rate, caseInsensitive, marks, sent) : []),
    [listing, cull, rate, caseInsensitive, marks, sent],
  );

  return {
    folder,
    recursive,
    listing,
    photos,
    loading,
    error,
    recent,
    ratedWith: rate[0]?.profile,
    open,
    setRecursive,
    setCull,
    setRate,
    mark,
    reset,
    send,
    following,
  };
}
