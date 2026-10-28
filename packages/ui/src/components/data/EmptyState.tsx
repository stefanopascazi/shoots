/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { Icon } from '../../icons/Icon.js';
import type { IconName } from '../../icons/paths.js';

export interface EmptyStateProps {
  icon?: IconName;
  title: ComponentChildren;
  description?: ComponentChildren;
  actions?: ComponentChildren;
}

export function EmptyState({ icon = 'image', title, description, actions }: EmptyStateProps) {
  return (
    <div class="sh-empty">
      <div class="sh-empty__icon">
        <Icon name={icon} size={22} />
      </div>
      <h3 class="sh-empty__title">{title}</h3>
      {description && <p class="sh-empty__description">{description}</p>}
      {actions && <div class="sh-empty__actions">{actions}</div>}
    </div>
  );
}
