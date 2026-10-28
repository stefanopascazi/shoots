/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';

export interface CardProps {
  title?: ComponentChildren;
  description?: ComponentChildren;
  /** Header actions, right-aligned. */
  actions?: ComponentChildren;
  footer?: ComponentChildren;
  /** Body without padding, for tables and media that run edge to edge. */
  flush?: boolean;
  onClick?: () => void;
  class?: string;
  children?: ComponentChildren;
}

export function Card({ title, description, actions, footer, flush, onClick, class: className, children }: CardProps) {
  return (
    <section class={cx('sh-card', onClick && 'sh-card--interactive', className)} onClick={onClick}>
      {(title || actions) && (
        <header class="sh-card__header">
          <div>
            {title && <h2 class="sh-card__title">{title}</h2>}
            {description && <p class="sh-card__description">{description}</p>}
          </div>
          {actions && <div class="sh-card__actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && (flush ? children : <div class="sh-card__body">{children}</div>)}
      {footer && <footer class="sh-card__footer">{footer}</footer>}
    </section>
  );
}
