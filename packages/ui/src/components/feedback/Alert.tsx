/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';
import { Icon } from '../../icons/Icon.js';
import type { IconName } from '../../icons/paths.js';
import type { Tone } from './Badge.js';

export type AlertTone = Exclude<Tone, 'accent'>;

const TONE_ICON: Record<AlertTone, IconName> = {
  neutral: 'info',
  info: 'info',
  success: 'check-circle',
  warning: 'alert',
  danger: 'alert',
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ComponentChildren;
  /** Trailing slot, typically a button. */
  action?: ComponentChildren;
  class?: string;
  children?: ComponentChildren;
}

export function Alert({ tone = 'neutral', title, action, class: className, children }: AlertProps) {
  return (
    <div
      class={cx('sh-alert', tone !== 'neutral' && `sh-alert--${tone}`, className)}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <Icon name={TONE_ICON[tone]} size={16} />
      <div>
        {title && <div class="sh-alert__title">{title}</div>}
        {children && <div class="sh-alert__body">{children}</div>}
      </div>
      {action ?? <span />}
    </div>
  );
}
