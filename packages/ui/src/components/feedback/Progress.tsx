/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';

export interface ProgressProps {
  /** 0–1. Omit for an indeterminate bar. */
  value?: number;
  label?: ComponentChildren;
  /** Right-hand text; defaults to the percentage when the value is known. */
  detail?: ComponentChildren;
  class?: string;
}

/** Clamps a fraction to [0, 1]; anything not finite reads as 0. */
export const clampFraction = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function Progress({ value, label, detail, class: className }: ProgressProps) {
  const known = value !== undefined;
  const pct = known ? Math.round(clampFraction(value) * 100) : undefined;
  const right = detail ?? (known ? `${pct}%` : undefined);
  return (
    <div class={cx('sh-progress', !known && 'sh-progress--indeterminate', className)}>
      {(label || right) && (
        <div class="sh-progress__meta">
          <strong>{label}</strong>
          <span class="sh-num">{right}</span>
        </div>
      )}
      <div
        class="sh-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div class="sh-progress__bar" style={known ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}
