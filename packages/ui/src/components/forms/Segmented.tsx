/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';
import { Icon } from '../../icons/Icon.js';
import type { IconName } from '../../icons/paths.js';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ComponentChildren;
  icon?: IconName;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange?: (value: T) => void;
  label: string;
  class?: string;
}

/** A small single-choice group: view modes, filters, treatments. */
export function Segmented<T extends string>({ options, value, onChange, label, class: className }: SegmentedProps<T>) {
  return (
    <div class={cx('sh-segmented', className)} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          class="sh-segmented__item"
          aria-checked={o.value === value ? 'true' : 'false'}
          onClick={() => onChange?.(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
