/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { Alert, Button, Card, Dialog } from '@shoots/ui';
import { api } from '../api/client.js';

/**
 * Forget everything the app remembers. Only the app's own database is cleared:
 * photos and Lightroom are not touched.
 */
export function MemoryCard() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const clear = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.clearMemory();
      // A fresh load, not a route change: switching to the library on this page would
      // reopen the old folder and write it straight back into the cleared memory.
      location.replace(location.pathname);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Card title="App memory" description="What the app remembers between sessions.">
      <div class="app-side">
        <p class="sh-muted app-note">
          Settings, recent folders, blur checks, ratings, your flags, stars and labels, and the send history. Photos and Lightroom are never touched.
        </p>
        <Button variant="danger" icon="trash" onClick={() => setConfirming(true)}>
          Clear app memory…
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Clear the app memory?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon="trash" loading={busy} onClick={clear}>
              Clear everything
            </Button>
          </>
        }
      >
        <div class="app-reset">
          <p>
            The app forgets every folder, result, mark and setting. Your photos stay as they are, and anything already sent stays in Lightroom. This
            cannot be undone.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </Dialog>
    </Card>
  );
}
