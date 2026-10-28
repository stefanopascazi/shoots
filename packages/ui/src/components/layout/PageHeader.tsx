/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';

export interface PageHeaderProps {
  eyebrow?: ComponentChildren;
  title: ComponentChildren;
  description?: ComponentChildren;
  actions?: ComponentChildren;
}

export function PageHeader({ eyebrow, title, description, actions }: PageHeaderProps) {
  return (
    <div class="sh-page-header">
      <div class="sh-page-header__text">
        {eyebrow && <div class="sh-eyebrow">{eyebrow}</div>}
        <h1 class="sh-page-header__title">{title}</h1>
        {description && <p class="sh-page-header__description">{description}</p>}
      </div>
      {actions && <div class="sh-page-header__actions">{actions}</div>}
    </div>
  );
}
