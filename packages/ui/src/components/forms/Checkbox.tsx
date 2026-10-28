/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';

export interface CheckboxProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Secondary line under the label. */
  hint?: ComponentChildren;
  class?: string;
  children: ComponentChildren;
}

/** A native checkbox, so keyboard and assistive tech behave as everywhere else. */
export function Checkbox({ checked, onChange, disabled, hint, class: className, children }: CheckboxProps) {
  return (
    <label class={cx('sh-check', disabled && 'sh-check--disabled', className)}>
      <input
        type="checkbox"
        class="sh-check__box"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="sh-check__text">
        <span>{children}</span>
        {hint && <span class="sh-check__hint">{hint}</span>}
      </span>
    </label>
  );
}
