"use client";

import { useEffect, useState } from "react";

import type { TocEntry } from "@/lib/docs/markdown";

/** Highlights the section currently in view. */
function useActiveHeading(entries: TocEntry[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(entries[0]?.id);

  useEffect(() => {
    const headings = entries
      .map((entry) => document.getElementById(entry.id))
      .filter((node): node is HTMLElement => Boolean(node));
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter((record) => record.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -70% 0px", threshold: 0 },
    );

    headings.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [entries]);

  return active;
}

export function DocsToc({ entries }: { entries: TocEntry[] }) {
  const active = useActiveHeading(entries);

  if (entries.length === 0) return null;

  return (
    <nav aria-label="On this page" className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-subtle">On this page</p>
      <ul className="space-y-1.5 border-l border-border-base">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              href={`#${entry.id}`}
              className={`-ml-px block border-l-2 py-0.5 text-xs transition-colors ${
                entry.depth === 3 ? "pl-6" : "pl-3"
              } ${
                active === entry.id
                  ? "border-accent font-medium text-fg"
                  : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {entry.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
