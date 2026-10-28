/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Alert, Button, Checkbox, Dialog } from '@shoots/ui';
import type { ResetPart } from '../contract.js';

const PARTS: { part: ResetPart; label: string; hint: string }[] = [
  { part: 'cull', label: 'Blur check', hint: 'The results of Find blurry.' },
  { part: 'rate', label: "shoots' ratings", hint: 'The stars from the last Rate.' },
  { part: 'marks', label: 'Your marks', hint: 'Flags, stars and colour labels you set by hand.' },
  { part: 'sent', label: 'Send history', hint: 'What was sent to Lightroom; a send not collected yet is withdrawn.' },
];

export interface ResetDialogProps {
  open: boolean;
  /** What is being reset, in words: "2025-08-15 (19 photos)" or a file name. */
  scope: string;
  onClose: () => void;
  onReset: (parts: ResetPart[]) => Promise<void>;
}

/** Forget some or all of what the app knows about a folder or a photo. Lightroom is never touched. */
export function ResetDialog({ open, scope, onClose, onReset }: ResetDialogProps) {
  const [chosen, setChosen] = useState<Set<ResetPart>>(new Set(PARTS.map((p) => p.part)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);

  const toggle = (part: ResetPart, on: boolean) =>
    setChosen((s) => {
      const next = new Set(s);
      if (on) next.add(part);
      else next.delete(part);
      return next;
    });

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onReset(PARTS.map((p) => p.part).filter((p) => chosen.has(p)));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reset ${scope}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" icon="trash" loading={busy} disabled={chosen.size === 0} onClick={confirm}>
            Reset
          </Button>
        </>
      }
    >
      <div class="app-reset">
        <p>Choose what the app should forget. Photos and Lightroom are not touched: anything already sent stays in the catalog.</p>
        {PARTS.map((p) => (
          <Checkbox checked={chosen.has(p.part)} onChange={(on) => toggle(p.part, on)} hint={p.hint}>
            {p.label}
          </Checkbox>
        ))}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
