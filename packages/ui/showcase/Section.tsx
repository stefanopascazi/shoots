/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';

export function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ComponentChildren }) {
  return (
    <section id={id} class="sc-section">
      <header class="sc-section__head">
        <h2>{title}</h2>
        {description && <p class="sh-muted">{description}</p>}
      </header>
      {children}
    </section>
  );
}

export function Specimen({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="sc-specimen">
      <div class="sh-eyebrow">{label}</div>
      <div class="sc-specimen__body">{children}</div>
    </div>
  );
}
