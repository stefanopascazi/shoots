import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { docsHref, findNeighbours } from "@/lib/docs/nav";

export function DocsPager({ slug }: { slug: string[] }) {
  const { previous, next } = findNeighbours(slug);
  if (!previous && !next) return null;

  return (
    <nav className="mt-14 flex flex-col gap-3 border-t border-border-soft pt-8 sm:flex-row">
      {previous && (
        <Link
          href={docsHref(previous.slug)}
          className="group flex flex-1 items-center gap-3 rounded-xl border border-border-base bg-surface p-3.5 transition-colors hover:border-subtle"
        >
          <ChevronLeft className="size-4 shrink-0 text-subtle" aria-hidden />
          <span className="min-w-0">
            <span className="block text-[10px] font-bold uppercase tracking-widest text-subtle">
              Previous
            </span>
            <span className="block truncate text-sm font-semibold text-fg">{previous.title}</span>
          </span>
        </Link>
      )}

      {next && (
        <Link
          href={docsHref(next.slug)}
          className="group flex flex-1 items-center justify-end gap-3 rounded-xl border border-border-base bg-surface p-3.5 text-right transition-colors hover:border-subtle"
        >
          <span className="min-w-0">
            <span className="block text-[10px] font-bold uppercase tracking-widest text-subtle">
              Next
            </span>
            <span className="block truncate text-sm font-semibold text-fg">{next.title}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden />
        </Link>
      )}
    </nav>
  );
}
