/** @jsxImportSource preact */
import { cx } from '../../cx.js';

/** Lightroom's colour labels, in its own order. */
export const PHOTO_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type PhotoLabel = (typeof PHOTO_LABELS)[number];

const NAMES: Record<PhotoLabel, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' };

export interface LabelPickerProps {
  value: PhotoLabel | undefined;
  /** Choosing the current label again clears it, as Lightroom does. */
  onChange: (label: PhotoLabel | undefined) => void;
  /** Keyboard hint per swatch, e.g. Lightroom's 6–9. */
  keys?: Partial<Record<PhotoLabel, string>>;
  class?: string;
}

export function LabelPicker({ value, onChange, keys, class: className }: LabelPickerProps) {
  return (
    <div class={cx('sh-labels', className)} role="radiogroup" aria-label="Colour label">
      {PHOTO_LABELS.map((l) => (
        <button
          type="button"
          role="radio"
          class={cx('sh-labels__swatch', `sh-labels__swatch--${l}`)}
          aria-checked={value === l ? 'true' : 'false'}
          aria-label={NAMES[l]}
          title={keys?.[l] ? `${NAMES[l]} (${keys[l]})` : NAMES[l]}
          onClick={() => onChange(value === l ? undefined : l)}
        />
      ))}
    </div>
  );
}
