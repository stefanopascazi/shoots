/** @jsxImportSource preact */
import type { JSX } from 'preact';
import { FILLED_ICONS, ICON_PATHS, type IconName } from './paths.js';

export interface IconProps extends Omit<JSX.SVGAttributes<SVGSVGElement>, 'name' | 'size'> {
  name: IconName;
  size?: number;
  /** Accessible name; without it the icon is decorative and hidden from assistive tech. */
  label?: string;
}

export function Icon({ name, size = 16, label, class: className, ...rest }: IconProps) {
  const filled = FILLED_ICONS.has(name);
  const paths = ICON_PATHS[name === 'star-fill' ? 'star' : name];
  return (
    <svg
      class={className ? `sh-icon ${className}` : 'sh-icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width={1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      {...rest}
    >
      {paths.map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

/** The shoots mark, from assets/shoots.svg. */
export function LogoMark({ size = 24 }: { size?: number }) {
  const blades = [
    ['M128 76L173.03 102L200.75 86Z', 0.95],
    ['M173.03 102L173.03 154L200.75 170Z', 0.62],
    ['M173.03 154L128 180L128 212Z', 0.95],
    ['M128 180L82.97 154L55.25 170Z', 0.62],
    ['M82.97 154L82.97 102L55.25 86Z', 0.95],
    ['M82.97 102L128 76L128 44Z', 0.62],
  ] as const;
  return (
    <svg class="sh-logo" width={size} height={size} viewBox="0 0 256 256" aria-hidden="true">
      <rect width="256" height="256" rx="52" fill="#171b21" />
      {blades.map(([d, o]) => (
        <path d={d} fill="#ffd479" fill-opacity={o} />
      ))}
      <circle cx="128" cy="128" r="92" fill="none" stroke="#f0b429" stroke-width="16" />
    </svg>
  );
}
