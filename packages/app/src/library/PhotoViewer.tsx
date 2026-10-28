/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, IconButton, Kbd, StarRating } from '@shoots/ui';
import { thumbUrl } from '../api/client.js';
import { FocusHeatmap, HeatLegend } from './FocusHeatmap.js';
import { formatBytes, isRejected, SEND_LABEL, verdictSource, type Decision, type PhotoView } from './model.js';

export interface PhotoViewerProps {
  photos: readonly PhotoView[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onDecide: (path: string, decision: Decision | undefined) => void;
  /** Review queue: a decision moves on to the next frame, and the last one closes. */
  review?: boolean;
}

/**
 * One photograph large, with what the analysis found and the last word on it.
 * Keys: ← → move, K keep, X or D reject, U undo, S skip, H heatmap, Esc close.
 */
export function PhotoViewer({ photos, index, onIndex, onClose, onDecide, review = false }: PhotoViewerProps) {
  const photo = photos[index];
  const [heatmap, setHeatmap] = useState(review);
  // The frame takes the photograph's own proportions so the focus map lands on it exactly.
  const [ratio, setRatio] = useState(1.5);
  const last = index === photos.length - 1;

  const next = () => (last ? (review ? onClose() : undefined) : onIndex(index + 1));
  const decide = (d: Decision | undefined) => {
    if (!photo?.blur) return;
    onDecide(photo.path, d);
    if (review && d) next();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') onClose();
      else if (key === 'arrowleft' && index > 0) onIndex(index - 1);
      else if (key === 'arrowright' && !last) onIndex(index + 1);
      else if (key === 'k') decide('keep');
      else if (key === 'x' || key === 'd') decide('reject');
      else if (key === 'u') decide(undefined);
      else if (key === 's') next();
      else if (key === 'h') setHeatmap((h) => !h);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (!photo) return null;
  const blur = photo.blur;
  const rejected = isRejected(photo);

  return (
    <div class="app-viewer" role="dialog" aria-modal="true" aria-label={photo.name}>
      <div class="app-viewer__stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div class="app-viewer__frame" style={{ '--ratio': String(ratio) }}>
          <img
            key={photo.path}
            src={thumbUrl(photo.path, 1600)}
            alt={photo.name}
            onLoad={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              if (img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight);
            }}
          />
          {heatmap && blur?.focusMap && <FocusHeatmap map={blur.focusMap} />}
        </div>
      </div>
      <aside class="app-viewer__panel">
        <div class="app-viewer__head">
          <div>
            {review && <div class="sh-eyebrow">Review · {index + 1} of {photos.length}</div>}
            <div class="app-viewer__name">{photo.name}</div>
            <div class="sh-subtle app-viewer__meta">
              {review ? '' : `${index + 1} of ${photos.length} · `}
              {photo.kind === 'raw' ? 'RAW' : 'Image'} · {formatBytes(photo.size)}
            </div>
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>

        {blur && (
          <section class="app-decision">
            <div class="app-decision__state">
              <Badge tone={photo.decision ? 'accent' : rejected ? 'danger' : blur.rescued ? 'warning' : 'success'}>
                {rejected ? 'Rejected' : 'Kept'}
              </Badge>
              <span class="sh-muted">{verdictSource(photo)}</span>
            </div>
            <div class="app-decision__actions">
              <Button size="sm" variant={photo.decision === 'keep' ? 'primary' : 'secondary'} icon="check" onClick={() => decide('keep')}>
                Keep
              </Button>
              <Button size="sm" variant={photo.decision === 'reject' ? 'danger' : 'secondary'} icon="x" onClick={() => decide('reject')}>
                Reject
              </Button>
              {photo.decision && (
                <Button size="sm" variant="ghost" icon="refresh" onClick={() => decide(undefined)}>
                  Undo
                </Button>
              )}
            </div>
            {blur.rescued && !photo.decision && (
              <p class="app-decision__why sh-muted">
                Most of the frame is soft but one area is sharp, as with a wide aperture. Check where focus landed, then keep or reject.
              </p>
            )}
          </section>
        )}

        <dl class="app-facts">
          {SEND_LABEL[photo.send] && (
            <>
              <dt>Lightroom</dt>
              <dd>{SEND_LABEL[photo.send]}</dd>
            </>
          )}
          <dt>Rating</dt>
          <dd>{photo.stars === undefined ? <span class="sh-subtle">Not rated yet</span> : <StarRating value={photo.stars} size={16} />}</dd>
          {blur ? (
            <>
              <dt>Sharpness</dt>
              <dd class="sh-num">{blur.score.toFixed(0)} overall · {blur.focusPeak.toFixed(0)} at the peak</dd>
              {blur.aperture !== null && (
                <>
                  <dt>Aperture</dt>
                  <dd class="sh-num">f/{blur.aperture}</dd>
                </>
              )}
            </>
          ) : (
            <>
              <dt>Focus</dt>
              <dd class="sh-subtle">Not checked yet</dd>
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

        {blur?.focusMap && (
          <div class="app-heat-toggle">
            <Button size="sm" variant={heatmap ? 'primary' : 'secondary'} onClick={() => setHeatmap((h) => !h)}>
              {heatmap ? 'Hide focus map' : 'Show focus map'}
            </Button>
            {heatmap && <HeatLegend />}
          </div>
        )}

        <div class="app-viewer__nav">
          <IconButton icon="chevron-left" label="Previous" variant="secondary" disabled={index === 0} onClick={() => onIndex(index - 1)} />
          <IconButton icon="chevron-right" label="Next" variant="secondary" disabled={last} onClick={() => onIndex(index + 1)} />
          <span class="sh-subtle app-viewer__keys">
            <Kbd>K</Kbd> keep · <Kbd>X</Kbd> reject · <Kbd>U</Kbd> undo · <Kbd>S</Kbd> skip · <Kbd>H</Kbd> focus map · <Kbd>Esc</Kbd> close
          </span>
        </div>
      </aside>
    </div>
  );
}
