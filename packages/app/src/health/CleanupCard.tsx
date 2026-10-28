/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Alert, Button, Card, Checkbox, Dialog } from '@shoots/ui';
import { api } from '../api/client.js';
import type { CleanupItem, CleanupPart } from '../contract.js';
import { initialSelection, itemFor, PARTS, size } from './cleanup.js';

/**
 * Remove what training, calibration and export checks left behind, so a run that
 * went wrong never needs cleaning up by hand. Photos and Lightroom are untouched.
 */
export function CleanupCard() {
  const [items, setItems] = useState<CleanupItem[]>();
  const [chosen, setChosen] = useState<Set<CleanupPart>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  const load = () =>
    api.cleanupPreview().then(
      ({ items }) => {
        setItems(items);
        setChosen(initialSelection(items));
      },
      (e: Error) => setError(e.message),
    );

  useEffect(() => {
    void load();
  }, []);

  const toggle = (part: CleanupPart, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(part);
    else next.delete(part);
    setChosen(next);
  };

  const clean = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { removed } = await api.cleanup([...chosen]);
      setDone(removed.length > 0 ? `Removed: ${removed.map((r) => PARTS.find((p) => p.part === r.part)?.label ?? r.part).join(', ')}.` : 'Nothing was left to remove.');
      setConfirming(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Training data" description="What training, calibration and export checks keep on this computer.">
      <div class="app-side">
        {PARTS.map((p) => {
          const item = items && itemFor(items, p.part);
          return (
            <Checkbox
              checked={chosen.has(p.part)}
              disabled={!item || item.count === 0 || busy}
              onChange={(on) => toggle(p.part, on)}
              hint={`${p.hint} · ${item ? size(item.bytes, item.count) : '…'}`}
            >
              {p.label}
            </Checkbox>
          );
        })}
        {chosen.has('journal') && (
          <Alert tone="warning" title="The journal cannot be rebuilt">
            It records what you corrected after each prediction, on the day you did it.
          </Alert>
        )}
        {done && <Alert tone="success">{done}</Alert>}
        {error && !confirming && <Alert tone="danger">{error}</Alert>}
        <Button variant="danger" icon="trash" disabled={chosen.size === 0} onClick={() => setConfirming(true)}>
          Remove selected…
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Remove the selected training data?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon="trash" loading={busy} onClick={clean}>
              Remove
            </Button>
          </>
        }
      >
        <div class="app-reset">
          <p>
            {PARTS.filter((p) => chosen.has(p.part))
              .map((p) => p.label)
              .join(', ')}{' '}
            will be removed. Your photos and Lightroom are not touched. This cannot be undone.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </Dialog>
    </Card>
  );
}
