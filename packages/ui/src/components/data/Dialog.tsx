/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface DialogProps {
  open: boolean;
  title: ComponentChildren;
  /** Called on Esc, backdrop click or any close request. */
  onClose: () => void;
  footer?: ComponentChildren;
  children?: ComponentChildren;
}

/** Native <dialog>: focus trapping, Esc and the top layer come from the browser. */
export function Dialog({ open, title, onClose, footer, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      class="sh-dialog"
      onClose={onClose}
      // A click whose target is the dialog itself landed on the backdrop.
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div class="sh-dialog__header">
        <h2 class="sh-dialog__title">{title}</h2>
      </div>
      {children && <div class="sh-dialog__body">{children}</div>}
      {footer && <div class="sh-dialog__footer">{footer}</div>}
    </dialog>
  );
}
