/** @jsxImportSource preact */
import type { ComponentChildren, JSX } from 'preact';
import { cx } from '../../cx.js';
import { Icon } from '../../icons/Icon.js';
import type { IconName } from '../../icons/paths.js';
import { Spinner } from '../feedback/Spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'icon' | 'loading'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Shows a spinner in place of the icon and blocks further clicks. */
  loading?: boolean;
  block?: boolean;
  children?: ComponentChildren;
}

export const buttonClass = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string | false) =>
  cx('sh-btn', variant !== 'secondary' && `sh-btn--${variant}`, size !== 'md' && `sh-btn--${size}`, extra);

const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 };

export function Button({
  variant,
  size = 'md',
  icon,
  loading = false,
  block = false,
  disabled,
  type = 'button',
  class: className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      class={cx(buttonClass(variant, size, block && 'sh-btn--block'), className as string)}
      disabled={disabled || loading}
      aria-busy={loading ? 'true' : undefined}
      {...rest}
    >
      {loading ? <Spinner size={ICON_SIZE[size]} /> : icon && <Icon name={icon} size={ICON_SIZE[size]} />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'block'> {
  icon: IconName;
  /** Required: an icon-only button has no other accessible name. */
  label: string;
}

export function IconButton({ icon, label, variant = 'ghost', class: className, ...rest }: IconButtonProps) {
  return (
    <Button
      {...rest}
      variant={variant}
      icon={icon}
      aria-label={label}
      title={label}
      class={cx('sh-btn--icon', className as string)}
    />
  );
}
