/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';
import { Icon } from '../../icons/Icon.js';
import { Badge } from '../feedback/Badge.js';
import { StarRating } from './StarRating.js';

/** `review` marks a frame waiting for a person's decision. */
export type PhotoFlag = 'pick' | 'rejected' | 'review';

const FLAG_BADGE: Record<PhotoFlag, { tone: 'success' | 'danger' | 'warning'; label: string }> = {
  pick: { tone: 'success', label: 'Pick' },
  rejected: { tone: 'danger', label: 'Rejected' },
  review: { tone: 'warning', label: 'Review' },
};

export interface PhotoTileProps {
  src?: string;
  name: string;
  rating?: number;
  flag?: PhotoFlag;
  selected?: boolean;
  /** Width / height, e.g. 1.5 for 3:2. */
  ratio?: number;
  /** Extra content in the bottom overlay, after the name. */
  meta?: ComponentChildren;
  onClick?: () => void;
}

export function PhotoTile({ src, name, rating, flag, selected, ratio, meta, onClick }: PhotoTileProps) {
  return (
    <button
      type="button"
      class={cx('sh-photo', flag === 'rejected' && 'sh-photo--rejected')}
      aria-pressed={selected ? 'true' : 'false'}
      title={name}
      style={ratio ? { '--sh-ratio': String(ratio) } : undefined}
      onClick={onClick}
    >
      {src ? (
        <img src={src} alt={name} loading="lazy" decoding="async" />
      ) : (
        <span class="sh-photo__placeholder">
          <Icon name="image" size={22} />
        </span>
      )}
      {flag && (
        <span class="sh-photo__flag">
          <Badge tone={FLAG_BADGE[flag].tone}>{FLAG_BADGE[flag].label}</Badge>
        </span>
      )}
      <span class="sh-photo__overlay">
        <span class="sh-photo__name">{name}</span>
        {meta}
        {rating !== undefined && rating > 0 && <StarRating value={rating} size={11} />}
      </span>
    </button>
  );
}

export function Filmstrip({ thumb, children }: { thumb?: number; children: ComponentChildren }) {
  return (
    <div class="sh-filmstrip" style={thumb ? { '--sh-thumb': `${thumb}px` } : undefined}>
      {children}
    </div>
  );
}

export function PhotoGrid({ thumb, children }: { thumb?: number; children: ComponentChildren }) {
  return (
    <div class="sh-photo-grid" style={thumb ? { '--sh-thumb': `${thumb}px` } : undefined}>
      {children}
    </div>
  );
}
