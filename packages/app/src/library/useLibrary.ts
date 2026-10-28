import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../api/client.js';
import type { CullResultItem, LibraryListing, RateResultItem, StoredRate } from '../contract.js';
import { clearLegacyDecisions, loadLegacyDecisions, withDecision } from './decisions.js';
import { mergeResults, type Decision, type Decisions, type PhotoView } from './model.js';

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
  /** Keep or reject a photo against the verdict; undefined hands it back to the verdict. */
  decide: (path: string, decision: Decision | undefined) => void;
}

export interface LibraryStart {
  folder: string | null;
  recursive: boolean;
  recent: string[];
}

/** The open folder, its photos, and everything known about them — stored by the server. */
export function useLibrary(caseInsensitive: boolean, start: LibraryStart): LibraryState {
  const [recent, setRecent] = useState(start.recent);
  const [folder, setFolder] = useState<string | undefined>(start.folder ?? undefined);
  const [recursive, setRecursive] = useState(start.recursive);
  const [listing, setListing] = useState<LibraryListing>();
  const [cull, setCull] = useState<CullResultItem[]>([]);
  const [rate, setRateItems] = useState<StoredRate[]>([]);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!folder) return;
    let alive = true;
    setLoading(true);
    setError(undefined);
    api.library(folder, recursive).then(
      async (l) => {
        if (!alive) return;
        // Decisions made before the database existed lived in this browser: hand them over once.
        const legacy = loadLegacyDecisions(l.folder);
        if (Object.keys(legacy).length) {
          await api.saveDecisions(legacy).then(() => clearLegacyDecisions(l.folder), () => {});
        }
        setListing(l);
        setCull(l.cull);
        setRateItems(l.rate);
        setDecisions({ ...legacy, ...l.decisions });
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
  }, [folder, recursive]);

  const open = useCallback((next: string) => {
    setCull([]);
    setRateItems([]);
    setFolder(next);
  }, []);

  const setRate = useCallback((results: RateResultItem[], profile: string) => {
    setRateItems(results.map((r) => ({ ...r, profile })));
  }, []);

  const decide = useCallback((path: string, decision: Decision | undefined) => {
    setDecisions((d) => withDecision(d, path, decision));
    void api.saveDecisions({ [path]: decision ?? null }).catch(() => {});
  }, []);

  const photos = useMemo(
    () => (listing ? mergeResults(listing.photos, cull, rate, caseInsensitive, decisions) : []),
    [listing, cull, rate, caseInsensitive, decisions],
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
    decide,
  };
}
