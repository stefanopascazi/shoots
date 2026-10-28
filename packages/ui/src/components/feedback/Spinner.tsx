/** @jsxImportSource preact */

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span
      class="sh-spinner"
      style={{ width: `${size}px`, height: `${size}px` }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    />
  );
}
