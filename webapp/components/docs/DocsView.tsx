import { Pencil } from "lucide-react";
import Link from "next/link";

import { DocsPager } from "@/components/docs/DocsPager";
import { DocsSidebarDrawer } from "@/components/docs/DocsSidebar";
import { DocsToc } from "@/components/docs/DocsToc";
import type { DocPage } from "@/lib/docs/content";
import { docsNav, slugKey } from "@/lib/docs/nav";
import { site } from "@/lib/site";

function groupNameFor(slug: string[]): string | undefined {
  return docsNav.find((group) =>
    group.items.some((item) => slugKey(item.slug) === slugKey(slug)),
  )?.name;
}

export function DocsView({ doc }: { doc: DocPage }) {
  const group = groupNameFor(doc.slug);

  return (
    <>
      <DocsSidebarDrawer currentTitle={doc.title} />

      <div className="mx-auto flex w-full max-w-5xl gap-10 px-4 py-10 sm:px-8">
        <article className="min-w-0 flex-1">
          <header className="space-y-3 border-b border-border-soft pb-6">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-subtle">
              <span>Docs</span>
              {group && (
                <>
                  <span aria-hidden>/</span>
                  <span className="text-muted">{group}</span>
                </>
              )}
            </p>
            <h1 className="text-3xl font-extrabold tracking-tight text-fg">{doc.title}</h1>
            {doc.description && (
              <p className="text-[15px] leading-relaxed text-muted">{doc.description}</p>
            )}
          </header>

          <div
            className="md-content pt-8"
            dangerouslySetInnerHTML={{ __html: doc.html }}
          />

          <DocsPager slug={doc.slug} />

          <p className="mt-8 text-xs text-subtle">
            <Link
              href={`${site.repoBlob}/${doc.repoPath}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 transition-colors hover:text-fg"
            >
              <Pencil className="size-3.5" aria-hidden />
              Edit this page on GitHub
            </Link>
          </p>
        </article>

        <aside className="sticky top-24 hidden h-fit w-56 shrink-0 xl:block">
          <DocsToc entries={doc.toc} />
        </aside>
      </div>
    </>
  );
}
