/** @jsxImportSource preact */
import { useEffect } from 'preact/hooks';
import { Badge, IconButton, Kbd, StarRating } from '@shoots/ui';
import { thumbUrl } from '../api/client.js';
import { formatBytes, isBlurry, type PhotoView } from './model.js';

export interface PhotoViewerProps {
  photos: readonly PhotoView[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/** One photograph large, with what the analysis found. Arrow keys move, Esc closes. */
export function PhotoViewer({ photos, index, onIndex, onClose }: PhotoViewerProps) {
  const photo = photos[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < photos.length - 1) onIndex(index + 1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [index, photos.length, onIndex, onClose]);

  if (!photo) return null;
  return (
    <div class="app-viewer" role="dialog" aria-modal="true" aria-label={photo.name}>
      <div class="app-viewer__stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <img key={photo.path} src={thumbUrl(photo.path, 1600)} alt={photo.name} />
      </div>
      <aside class="app-viewer__panel">
        <div class="app-viewer__head">
          <div>
            <div class="app-viewer__name">{photo.name}</div>
            <div class="sh-subtle app-viewer__meta">
              {index + 1} of {photos.length} · {photo.kind === 'raw' ? 'RAW' : 'Image'} · {formatBytes(photo.size)}
            </div>
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>

        <dl class="app-facts">
          <dt>Rating</dt>
          <dd>{photo.stars === undefined ? <span class="sh-subtle">Not rated yet</span> : <StarRating value={photo.stars} size={16} />}</dd>
          <dt>Focus</dt>
          <dd>
            {photo.blur ? (
              isBlurry(photo) ? (
                <Badge tone="danger">Blurry</Badge>
              ) : (
                <Badge tone="success">{photo.blur.rescued ? 'Sharp subject' : 'Sharp'}</Badge>
              )
            ) : (
              <span class="sh-subtle">Not checked yet</span>
            )}
          </dd>
          {photo.blur && (
            <>
              <dt>Sharpness</dt>
              <dd class="sh-num">{photo.blur.score.toFixed(0)}</dd>
            </>
          )}
          {photo.aesthetic !== undefined && (
            <>
              <dt>Aesthetic</dt>
              <dd class="sh-num">{(photo.aesthetic * 100).toFixed(0)} / 100</dd>
            </>
          )}
          {photo.keywords && photo.keywords.length > 0 && (
            <>
              <dt>Keywords</dt>
              <dd class="app-facts__tags">
                {photo.keywords.map((k) => (
                  <Badge>{k}</Badge>
                ))}
              </dd>
            </>
          )}
        </dl>

        <div class="app-viewer__nav">
          <IconButton icon="chevron-left" label="Previous" variant="secondary" disabled={index === 0} onClick={() => onIndex(index - 1)} />
          <IconButton
            icon="chevron-right"
            label="Next"
            variant="secondary"
            disabled={index === photos.length - 1}
            onClick={() => onIndex(index + 1)}
          />
          <span class="sh-subtle app-viewer__keys">
            <Kbd>←</Kbd> <Kbd>→</Kbd> move · <Kbd>Esc</Kbd> close
          </span>
        </div>
      </aside>
    </div>
  );
}
