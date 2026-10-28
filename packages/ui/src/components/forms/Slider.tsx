/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';

export interface SliderProps {
  id?: string;
  label: ComponentChildren;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Formats the live value and the two ends, e.g. `v => v.toFixed(2) + ' EV'`. */
  format?: (v: number) => string;
  showEnds?: boolean;
  disabled?: boolean;
  onChange?: (value: number) => void;
  class?: string;
}

/** Position of `value` along [min, max] as a CSS percentage, for the filled track. */
export function fillPercent(value: number, min: number, max: number): string {
  if (!(max > min)) return '0%';
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return `${Math.round(t * 1000) / 10}%`;
}

export function Slider({
  id,
  label,
  value,
  min,
  max,
  step = 0.01,
  format = String,
  showEnds = true,
  disabled,
  onChange,
  class: className,
}: SliderProps) {
  return (
    <div class={cx('sh-slider', className)}>
      <div class="sh-slider__head">
        <label class="sh-slider__label" for={id}>
          {label}
        </label>
        <output class="sh-slider__value" for={id}>
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        class="sh-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ '--sh-fill': fillPercent(value, min, max) }}
        onInput={(e) => onChange?.(Number((e.currentTarget as HTMLInputElement).value))}
      />
      {showEnds && (
        <div class="sh-slider__ends" aria-hidden="true">
          <span>{format(min)}</span>
          <span>{format(max)}</span>
        </div>
      )}
    </div>
  );
}
