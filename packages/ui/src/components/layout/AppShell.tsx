/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { cx } from '../../cx.js';
import { Icon, LogoMark } from '../../icons/Icon.js';
import type { IconName } from '../../icons/paths.js';

export function AppShell({ sidebar, children }: { sidebar: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="sh-app">
      {sidebar}
      <div class="sh-main">{children}</div>
    </div>
  );
}

export interface SidebarProps {
  /** Product name next to the mark. */
  title?: string;
  /** Small trailing text in the brand row, e.g. the version. */
  meta?: string;
  footer?: ComponentChildren;
  children: ComponentChildren;
}

export function Sidebar({ title = 'shoots', meta, footer, children }: SidebarProps) {
  return (
    <nav class="sh-sidebar" aria-label="Main">
      <div class="sh-sidebar__brand">
        <LogoMark size={24} />
        <span>{title}</span>
        {meta && <small>{meta}</small>}
      </div>
      {children}
      {footer && <div class="sh-sidebar__footer">{footer}</div>}
    </nav>
  );
}

export function SidebarSection({ children }: { children: ComponentChildren }) {
  return <div class="sh-sidebar__section sh-eyebrow">{children}</div>;
}

export interface NavItemProps {
  icon?: IconName;
  href?: string;
  active?: boolean;
  count?: number | string;
  onClick?: () => void;
  children: ComponentChildren;
}

export function NavItem({ icon, href, active, count, onClick, children }: NavItemProps) {
  const body = (
    <>
      {icon && <Icon name={icon} size={17} />}
      <span>{children}</span>
      {count !== undefined && <span class="sh-nav-item__count">{count}</span>}
    </>
  );
  const current = active ? 'page' : undefined;
  return href ? (
    <a class="sh-nav-item" href={href} aria-current={current} onClick={onClick}>
      {body}
    </a>
  ) : (
    <button type="button" class="sh-nav-item" aria-current={current} onClick={onClick}>
      {body}
    </button>
  );
}

export function Topbar({ title, children }: { title?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <header class="sh-topbar">
      {title && <div class="sh-topbar__title">{title}</div>}
      {children}
    </header>
  );
}

export function Content({ full, children }: { full?: boolean; children: ComponentChildren }) {
  return <main class={cx('sh-content', full && 'sh-content--full')}>{children}</main>;
}
