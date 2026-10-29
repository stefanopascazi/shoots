import { useEffect, useState } from 'preact/hooks';
import { api } from '../api/client.js';
import type { PhotoExif } from '../contract.js';

// Paging back and forth in the viewer should not ask exiftool again.
const cache = new Map<string, PhotoExif>();

export type ExifState = { state: 'loading' } | { state: 'ready'; exif: PhotoExif } | { state: 'failed'; error: string };

/** The photo's capture data, fetched once per path. */
export function useExif(path: string): ExifState {
  const [result, setResult] = useState<ExifState>(() => {
    const hit = cache.get(path);
    return hit ? { state: 'ready', exif: hit } : { state: 'loading' };
  });

  useEffect(() => {
    const hit = cache.get(path);
    if (hit) return setResult({ state: 'ready', exif: hit });
    let alive = true;
    setResult({ state: 'loading' });
    api.exif(path).then(
      (exif) => {
        cache.set(path, exif);
        if (alive) setResult({ state: 'ready', exif });
      },
      (e: Error) => alive && setResult({ state: 'failed', error: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [path]);

  return result;
}
