/** @jsxImportSource preact */
import { Badge, Button, LabelPicker, Segmented, StarRating, type PhotoLabel } from '@shoots/ui';
import type { Flag, MarksPatch } from '../contract.js';
import { verdictSource, type PhotoView } from './model.js';

const FLAG_OPTIONS: { value: Flag; label: string }[] = [
  { value: 'pick', label: 'Pick' },
  { value: 'unflagged', label: 'Unflagged' },
  { value: 'reject', label: 'Reject' },
];

const LABEL_KEYS: Partial<Record<PhotoLabel, string>> = { red: '6', yellow: '7', green: '8', blue: '9' };

export interface MarksPanelProps {
  photo: PhotoView;
  onMark: (patch: MarksPatch) => void;
}

/** Flag, stars and colour label, set by hand. Each one overrides what shoots proposed, until handed back. */
export function MarksPanel({ photo, onMark }: MarksPanelProps) {
  const own = photo.marks ?? {};
  const source = verdictSource(photo);
  return (
    <section class="app-marks" aria-label="Your marks">
      <div class="app-marks__row">
        <span class="app-marks__label">Flag</span>
        <Segmented<Flag> label="Flag" value={photo.flag} onChange={(flag) => onMark({ flag })} options={FLAG_OPTIONS} />
      </div>
      {source && (
        <div class="app-marks__note">
          <Badge tone={own.flag ? 'accent' : photo.blur?.rescued ? 'warning' : 'neutral'}>{source}</Badge>
          {own.flag && photo.blur && (
            <Button size="sm" variant="ghost" onClick={() => onMark({ flag: null })}>
              Use the cull's verdict
            </Button>
          )}
        </div>
      )}

      <div class="app-marks__row">
        <span class="app-marks__label">Stars</span>
        <StarRating value={photo.stars ?? 0} size={20} onChange={(stars) => onMark({ stars })} />
      </div>
      {own.stars !== undefined && photo.aiStars !== undefined && (
        <div class="app-marks__note">
          <Badge tone="accent">Set by you</Badge>
          <Button size="sm" variant="ghost" onClick={() => onMark({ stars: null })}>
            Use shoots' rating ({photo.aiStars}★)
          </Button>
        </div>
      )}

      <div class="app-marks__row">
        <span class="app-marks__label">Label</span>
        <LabelPicker value={photo.label} keys={LABEL_KEYS} onChange={(label) => onMark({ label: label ?? 'none' })} />
      </div>
    </section>
  );
}
