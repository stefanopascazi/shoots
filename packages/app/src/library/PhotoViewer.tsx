/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, IconButton } from '@shoots/ui';
import { thumbUrl } from '../api/client.js';
import type { MarksPatch, ResetPart } from '../contract.js';
import { ExifFacts } from './ExifFacts.js';
import { FocusHeatmap, HeatLegend } from './FocusHeatmap.js';
import { MarksPanel } from './MarksPanel.js';
import { formatBytes, SEND_LABEL, type PhotoView } from './model.js';
import { ResetDialog } from './ResetDialog.js';
import { toggleLabel, viewerKey } from './viewerKeys.js';

export interface PhotoViewerProps {
  photos: readonly PhotoView[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onMark: (path: string, patch: MarksPatch) => void;
  onReset: (path: string, parts: ResetPart[]) => Promise<void>;
  /** Review queue: setting a flag moves on to the next frame, and the last one closes. */
  review?: boolean;
}

/**
 * One photograph large, with what the analysis found and your marks on it.
 * Lightroom's keys: P X U flags, 0–5 stars, 6–9 labels; S skip, H focus map.
 */
export function PhotoViewer({ photos, index, onIndex, onClose, onMark, onReset, review = false }: PhotoViewerProps) {
  const photo = photos[index];
  const [heatmap, setHeatmap] = useState(review);
  const [resetting, setResetting] = useState(false);
  // The frame takes the photograph's own proportions so the focus map lands on it exactly.
  const [ratio, setRatio] = useState(1.5);
  const last = index === photos.length - 1;

  const next = () => (last ? (review ? onClose() : undefined) : onIndex(index + 1));
  const mark = (patch: MarksPatch) => {
    if (!photo) return;

    const effective = toggleLabel(patch, photo.label);
    onMark(photo.path, effective);
    if (review && patch.flag) next();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (resetting || e.ctrlKey || e.metaKey || e.altKey) return;
      const action = viewerKey(e.key);
      if (!action) return;
      e.preventDefault();
      if (action.type === 'close') onClose();
      else if (action.type === 'prev' && index > 0) onIndex(index - 1);
      else if (action.type === 'next' && !last) onIndex(index + 1);
      else if (action.type === 'skip') next();
      else if (action.type === 'heatmap') setHeatmap((h) => !h);
      else if (action.type === 'mark') mark(action.patch);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (!photo) return null;
  const blur = photo.blur;

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

        <MarksPanel photo={photo} onMark={mark} />
        {review && blur?.rescued && !photo.marks?.flag && (
          <p class="app-decision__why sh-muted">
            Most of the frame is soft but one area is sharp, as with a wide aperture. Check where focus landed, then pick or reject.
          </p>
        )}

        <dl class="app-facts">
          {SEND_LABEL[photo.send] && (
            <>
              <dt>Lightroom</dt>
              <dd>{SEND_LABEL[photo.send]}</dd>
            </>
          )}
          {blur ? (
            <>
              <dt>Sharpness</dt>
              <dd class="sh-num">
                {blur.score.toFixed(0)} overall · {blur.focusPeak.toFixed(0)} at the peak
              </dd>
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

        <ExifFacts key={photo.path} path={photo.path} />

        <div class="app-heat-toggle">
          {blur?.focusMap && (
            <Button size="sm" variant={heatmap ? 'primary' : 'secondary'} onClick={() => setHeatmap((h) => !h)}>
              {heatmap ? 'Hide focus map' : 'Show focus map'}
            </Button>
          )}
          {heatmap && blur?.focusMap && <HeatLegend />}
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setResetting(true)}>
            Reset this photo…
          </Button>
        </div>

        <div class="app-viewer__nav">
          <IconButton icon="chevron-left" label="Previous" variant="secondary" disabled={index === 0} onClick={() => onIndex(index - 1)} />
          <IconButton icon="chevron-right" label="Next" variant="secondary" disabled={last} onClick={() => onIndex(index + 1)} />
        </div>
      </aside>
      <ResetDialog open={resetting} scope={photo.name} onClose={() => setResetting(false)} onReset={(parts) => onReset(photo.path, parts)} />
    </div>
  );
}
