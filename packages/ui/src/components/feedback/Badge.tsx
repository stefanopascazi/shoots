/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  tone?: Tone;
  /** A leading status dot, for live states such as "running". */
  dot?: boolean;
  class?: string;
  children?: ComponentChildren;
}

export function Badge({ tone = 'neutral', dot = false, class: className, children }: BadgeProps) {
  return (
    <span class={cx('sh-badge', tone !== 'neutral' && `sh-badge--${tone}`, className)}>
      {dot && <span class="sh-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
