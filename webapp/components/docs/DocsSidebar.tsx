"use client";

import { BookOpen, Compass, Rocket, Settings2, Terminal, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { docsHref, docsNav, type DocsNavGroup } from "@/lib/docs/nav";
import { site } from "@/lib/site";

const icons: Record<DocsNavGroup["icon"], typeof Compass> = {
  compass: Compass,
  rocket: Rocket,
  book: BookOpen,
  terminal: Terminal,
  settings: Settings2,
};

function NavTree({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();

  const groups = docsNav
    .map((group) => ({
      ...group,
      items: needle
        ? group.items.filter((item) => item.title.toLowerCase().includes(needle))
        : group.items,
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="flex h-full flex-col gap-6 p-5">
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter pages…"
        className="w-full rounded-xl border border-border-base bg-surface px-3 py-1.5 text-xs text-fg placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent/30"
      />

      <nav className="flex-1 space-y-6">
        {groups.map((group) => {
          const Icon = icons[group.icon];
          return (
            <div key={group.name} className="space-y-1.5">
              <h4 className="flex items-center gap-1.5 px-2 text-[10px] font-bold uppercase tracking-widest text-subtle">
                <Icon className="size-3.5" aria-hidden />
                {group.name}
              </h4>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const href = docsHref(item.slug);
                  const isActive = pathname === href;
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        onClick={onNavigate}
                        className={`block truncate rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                          isActive
                            ? "bg-surface font-semibold text-fg shadow-sm ring-1 ring-border-base"
                            : "text-muted hover:bg-surface hover:text-fg"
                        }`}
                      >
                        {item.slug[0] === "commands" && item.slug.length > 1 ? (
                          <span className="font-mono">{item.title}</span>
                        ) : (
                          item.title
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

        {groups.length === 0 && (
          <p className="px-2 text-xs text-subtle">No page matches “{filter}”.</p>
        )}
      </nav>

      <div className="rounded-xl border border-border-base bg-surface p-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
          Current release
        </p>
        <div className="mt-1 flex items-center justify-between">
          <span className="font-mono text-xs font-bold text-fg">v{site.version}</span>
          <span className="size-2 rounded-full bg-accent" aria-hidden />
        </div>
      </div>
    </div>
  );
}

export function DocsSidebar() {
  return (
    <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-64 shrink-0 overflow-y-auto border-r border-border-soft bg-bg-muted md:block">
      <NavTree />
    </aside>
  );
}

export function DocsSidebarDrawer({ currentTitle }: { currentTitle: string }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="md:hidden">
      <div className="sticky top-[6.5rem] z-30 flex items-center justify-between gap-3 border-b border-border-soft bg-bg/90 px-4 py-2 backdrop-blur-md">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="rounded-lg border border-border-base bg-surface-muted px-3 py-1.5 text-xs font-semibold text-fg"
        >
          Browse docs
        </button>
        <span className="truncate text-xs text-subtle">{currentTitle}</span>
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="w-72 max-w-[85%] overflow-y-auto bg-bg-muted shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-soft px-5 py-3">
              <span className="text-xs font-bold uppercase tracking-widest text-subtle">
                Documentation
              </span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Close navigation"
                className="rounded-md p-1 text-subtle"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <NavTree onNavigate={() => setIsOpen(false)} />
          </div>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setIsOpen(false)}
            className="flex-1 bg-slate-950/40 backdrop-blur-sm"
          />
        </div>
      )}
    </div>
  );
}
