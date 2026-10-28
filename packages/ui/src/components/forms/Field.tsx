/** @jsxImportSource preact */
import type { ComponentChildren, JSX } from 'preact';
import { cx } from '../../cx.js';

export interface FieldProps {
  label: ComponentChildren;
  /** id of the control inside, so the label is wired to it. */
  htmlFor?: string;
  hint?: ComponentChildren;
  error?: ComponentChildren;
  class?: string;
  children: ComponentChildren;
}

export function Field({ label, htmlFor, hint, error, class: className, children }: FieldProps) {
  return (
    <div class={cx('sh-field', className)}>
      <label class="sh-field__label" for={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <div class="sh-field__error">{error}</div> : hint && <div class="sh-field__hint">{hint}</div>}
    </div>
  );
}

type InputProps = JSX.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export function Input({ invalid, class: className, ...rest }: InputProps) {
  return <input class={cx('sh-input', className as string)} aria-invalid={invalid ? 'true' : undefined} {...rest} />;
}

type SelectProps = JSX.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean };

export function Select({ invalid, class: className, children, ...rest }: SelectProps) {
  return (
    <select class={cx('sh-select', className as string)} aria-invalid={invalid ? 'true' : undefined} {...rest}>
      {children}
    </select>
  );
}

type TextareaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export function Textarea({ invalid, class: className, ...rest }: TextareaProps) {
  return <textarea class={cx('sh-textarea', className as string)} aria-invalid={invalid ? 'true' : undefined} {...rest} />;
}
