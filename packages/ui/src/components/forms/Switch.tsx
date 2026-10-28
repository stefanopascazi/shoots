/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';

export interface SwitchProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  children?: ComponentChildren;
  class?: string;
}

export function Switch({ checked, onChange, disabled, children, class: className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      class={cx('sh-switch', className)}
      aria-checked={checked ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
    >
      <span class="sh-switch__track" aria-hidden="true">
        <span class="sh-switch__thumb" />
      </span>
      {children}
    </button>
  );
}
