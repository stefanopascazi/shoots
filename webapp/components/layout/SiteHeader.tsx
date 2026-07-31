"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Logo } from "@/components/layout/Logo";
import { useSearch } from "@/components/search/SearchProvider";
import { GitHubIcon } from "@/components/ui/icons/GitHubIcon";
import { site } from "@/lib/site";

const links = [
  { href: "/", label: "Home", exact: true },
  { href: "/docs", label: "Documentation", exact: false },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { open } = useSearch();

  const isActive = (href: string, exact: boolean) =>
    exact ? pathname === href : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-40 border-b border-border-soft bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6 sm:gap-9">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-[17px] font-bold tracking-tight text-fg">shoots</span>
            <span className="rounded-full border border-border-base bg-surface-muted px-2 py-0.5 font-mono text-[10px] font-semibold text-muted">
              v{site.version}
            </span>
          </Link>

          <nav className="hidden items-center gap-7 text-sm md:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`transition-colors ${
                  isActive(link.href, link.exact)
                    ? "font-semibold text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={open}
            className="flex items-center gap-2 rounded-full border border-border-base bg-surface-muted px-3 py-1.5 text-xs text-subtle transition-colors hover:text-fg"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Search docs</span>
            <kbd className="hidden rounded border border-border-base bg-surface px-1.5 py-0.5 font-mono text-[10px] md:inline">
              ⌘K
            </kbd>
          </button>

          <Link
            href={site.repo}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub repository"
            className="rounded-full p-2 text-muted transition-colors hover:bg-surface-muted hover:text-fg"
          >
            <GitHubIcon className="size-[18px]" />
          </Link>
        </div>
      </div>

      <nav className="flex gap-2 border-t border-border-soft bg-surface-muted px-4 py-2 md:hidden">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`flex-1 rounded-full py-1.5 text-center text-xs font-medium transition-colors ${
              isActive(link.href, link.exact)
                ? "bg-fg text-bg"
                : "border border-border-base bg-surface text-muted"
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
