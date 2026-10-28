/** @jsxImportSource preact */
import { cx } from '../../cx.js';
import { Icon } from '../../icons/Icon.js';

export const MAX_STARS = 5;

/** Rounds and clamps to a whole number of stars in [0, 5]. */
export const clampStars = (v: number): number =>
  Number.isFinite(v) ? Math.min(MAX_STARS, Math.max(0, Math.round(v))) : 0;

export interface StarRatingProps {
  value: number;
  size?: number;
  /** Makes each star a button; clicking the current value clears it (Lightroom behaviour). */
  onChange?: (value: number) => void;
  class?: string;
}

export function StarRating({ value, size = 14, onChange, class: className }: StarRatingProps) {
  const stars = clampStars(value);
  const label = `${stars} of ${MAX_STARS} stars`;
  const items = Array.from({ length: MAX_STARS }, (_, i) => {
    const on = i < stars;
    const icon = <Icon name={on ? 'star-fill' : 'star'} size={size} />;
    const cls = cx('sh-stars__star', !on && 'sh-stars__star--off');
    return onChange ? (
      <button
        type="button"
        class={cls}
        aria-label={`${i + 1} star${i ? 's' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onChange(i + 1 === stars ? 0 : i + 1);
        }}
      >
        {icon}
      </button>
    ) : (
      <span class={cls}>{icon}</span>
    );
  });

  return onChange ? (
    <div class={cx('sh-stars', className)} role="group" aria-label={label}>
      {items}
    </div>
  ) : (
    <div class={cx('sh-stars', className)} role="img" aria-label={label}>
      {items}
    </div>
  );
}
