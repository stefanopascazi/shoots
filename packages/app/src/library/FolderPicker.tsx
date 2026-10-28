/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Alert, Button, Dialog, Icon, Spinner } from '@shoots/ui';
import { api } from '../api/client.js';
import type { BrowseResult } from '../contract.js';

export interface FolderPickerProps {
  open: boolean;
  /** Where to start; null starts at the drives. */
  start: string | null;
  onPick: (folder: string) => void;
  onClose: () => void;
}

/** Browses folders on this machine through the server: a browser page cannot see real paths. */
export function FolderPicker({ open, start, onPick, onClose }: FolderPickerProps) {
  const [at, setAt] = useState<string | null>(start);
  const [listing, setListing] = useState<BrowseResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setAt(start);
  }, [open, start]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(undefined);
    api.browse(at).then(
      (r) => alive && (setListing(r), setLoading(false)),
      (e: Error) => alive && (setError(e.message), setLoading(false)),
    );
    return () => {
      alive = false;
    };
  }, [open, at]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose a folder"
      footer={
        <>
          <span class="app-picker__count sh-muted">
            {listing?.path ? `${listing.images} photo${listing.images === 1 ? '' : 's'} in this folder` : ''}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!listing?.path} onClick={() => listing?.path && onPick(listing.path)}>
            Open folder
          </Button>
        </>
      }
    >
      <div class="app-picker">
        <div class="app-picker__path">
          <Button
            size="sm"
            variant="ghost"
            icon="chevron-left"
            disabled={listing?.path == null}
            onClick={() => setAt(listing?.parent ?? null)}
          >
            Up
          </Button>
          <code class="app-picker__current">{listing?.path ?? 'This computer'}</code>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <div class="app-picker__list" role="listbox" aria-label="Folders">
          {loading && !listing ? (
            <div class="app-picker__empty">
              <Spinner />
            </div>
          ) : listing?.dirs.length ? (
            listing.dirs.map((d) => (
              <button type="button" class="app-picker__item" onClick={() => setAt(d.path)} title={d.path}>
                <Icon name="folder" size={16} />
                <span>{d.name}</span>
                <Icon name="chevron-right" size={14} class="sh-subtle" />
              </button>
            ))
          ) : (
            <div class="app-picker__empty sh-muted">No subfolders here.</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
