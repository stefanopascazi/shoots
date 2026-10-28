import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../api/client.js';
import type { CullReport, LibraryListing, RateReport } from '../contract.js';
import { loadRecent, pushRecent, saveRecent } from './recentFolders.js';
import { mergeResults, type PhotoView } from './model.js';

export interface LibraryState {
  folder: string | undefined;
  recursive: boolean;
  listing: LibraryListing | undefined;
  photos: PhotoView[];
  loading: boolean;
  error: string | undefined;
  recent: string[];
  open: (folder: string) => void;
  setRecursive: (recursive: boolean) => void;
  setCull: (report: CullReport) => void;
  setRate: (report: RateReport) => void;
}

/** The open folder, its photos, and the latest analysis of them. */
export function useLibrary(caseInsensitive: boolean): LibraryState {
  const [recent, setRecent] = useState(loadRecent);
  const [folder, setFolder] = useState<string | undefined>(() => recent[0]);
  const [recursive, setRecursive] = useState(false);
  const [listing, setListing] = useState<LibraryListing>();
  const [cull, setCull] = useState<CullReport>();
  const [rate, setRate] = useState<RateReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!folder) return;
    let alive = true;
    setLoading(true);
    setError(undefined);
    api.library(folder, recursive).then(
      (l) => {
        if (!alive) return;
        setListing(l);
        setLoading(false);
        setRecent((r) => {
          const next = pushRecent(r, l.folder);
          saveRecent(next);
          return next;
        });
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
    setCull(undefined);
    setRate(undefined);
    setFolder(next);
  }, []);

  const photos = useMemo(
    () => (listing ? mergeResults(listing.photos, cull, rate, caseInsensitive) : []),
    [listing, cull, rate, caseInsensitive],
  );

  return { folder, recursive, listing, photos, loading, error, recent, open, setRecursive, setCull, setRate };
}
