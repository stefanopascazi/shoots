/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';

export interface TabItem<T extends string> {
  value: T;
  label: ComponentChildren;
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange?: (value: T) => void;
  label: string;
  class?: string;
}

export function Tabs<T extends string>({ items, value, onChange, label, class: className }: TabsProps<T>) {
  return (
    <div class={cx('sh-tabs', className)} role="tablist" aria-label={label}>
      {items.map((t) => (
        <button
          type="button"
          role="tab"
          class="sh-tab"
          aria-selected={t.value === value ? 'true' : 'false'}
          onClick={() => onChange?.(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
