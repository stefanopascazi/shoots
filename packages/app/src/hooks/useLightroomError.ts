import { useEffect, useState } from 'preact/hooks';
import { api } from '../api/client.js';
import type { LightroomError } from '../contract.js';

const POLL_MS = 5000;

/**
 * The last failure the plug-in reported from Lightroom, until dismissed. A newer
 * failure shows again: dismissing hides that one report, not the channel.
 */
export function useLightroomError(): { error: LightroomError | undefined; dismiss: () => void } {
  const [error, setError] = useState<LightroomError>();
  const [dismissedAt, setDismissedAt] = useState(0);

  useEffect(() => {
    let alive = true;
    const check = () =>
      api.sync().then(
        (s) => alive && setError(s.lightroomError ?? undefined),
        () => {},
      );
    void check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return {
    error: error && error.at > dismissedAt ? error : undefined,
    dismiss: () => setDismissedAt(error?.at ?? Date.now()),
  };
}
