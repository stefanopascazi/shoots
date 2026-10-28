import { useEffect, useState } from 'preact/hooks';
import { api } from '../api/client.js';

const EVERY_MS = 20_000;

/** Tells the server a page is open; reports whether it still answers. */
export function useHeartbeat(): boolean {
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    let alive = true;
    const beat = () =>
      api.heartbeat().then(
        () => alive && setConnected(true),
        () => alive && setConnected(false),
      );
    beat();
    const timer = setInterval(beat, EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return connected;
}
