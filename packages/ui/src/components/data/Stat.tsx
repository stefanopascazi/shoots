/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';

export interface StatProps {
  label: ComponentChildren;
  value: ComponentChildren;
  /** Unit after the value, smaller and dimmer: "photos", "%". */
  unit?: ComponentChildren;
  hint?: ComponentChildren;
  hintTone?: 'neutral' | 'success' | 'danger';
}

export function Stat({ label, value, unit, hint, hintTone = 'neutral' }: StatProps) {
  return (
    <div class="sh-stat">
      <div class="sh-stat__label">{label}</div>
      <div class="sh-stat__value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {hint && <div class={cx('sh-stat__hint', hintTone !== 'neutral' && `sh-stat__hint--${hintTone}`)}>{hint}</div>}
    </div>
  );
}
