/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="sh-kbd">{children}</kbd>;
}
