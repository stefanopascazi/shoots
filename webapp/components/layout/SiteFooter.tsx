import { Mail } from "lucide-react";
import Link from "next/link";

import { Logo } from "@/components/layout/Logo";
import { GitHubIcon } from "@/components/ui/icons/GitHubIcon";
import { site } from "@/lib/site";

const columns = [
  {
    title: "Documentation",
    links: [
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "Core concepts", href: "/docs/concepts" },
      { label: "Interactive shell", href: "/docs/shell" },
      { label: "Recipes", href: "/docs/recipes" },
    ],
  },
  {
    title: "Commands",
    links: [
      { label: "import", href: "/docs/commands/import" },
      { label: "cull", href: "/docs/commands/cull" },
      { label: "rate", href: "/docs/commands/rate" },
      { label: "develop", href: "/docs/commands/develop" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Repository", href: site.repo, external: true },
      { label: "Releases", href: site.releases, external: true },
      { label: "License", href: site.license.url, external: true },
      { label: "Troubleshooting", href: "/docs/troubleshooting" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border-soft bg-bg-muted">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="text-base font-bold tracking-tight text-fg">shoots</span>
          </div>
          <p className="max-w-xs text-xs leading-relaxed text-muted">{site.tagline}</p>
          <div className="flex items-center gap-2 pt-1">
            <Link
              href={site.repo}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-border-base p-2 text-muted transition-colors hover:text-fg"
              aria-label="GitHub repository"
            >
              <GitHubIcon />
            </Link>
            <Link
              href={`mailto:${site.email}`}
              className="rounded-full border border-border-base p-2 text-muted transition-colors hover:text-fg"
              aria-label="Email the author"
            >
              <Mail className="size-4" aria-hidden />
            </Link>
          </div>
        </div>

        {columns.map((column) => (
          <div key={column.title} className="space-y-3">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-subtle">
              {column.title}
            </h3>
            <ul className="space-y-2 text-xs">
              {column.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    {...("external" in link && link.external
                      ? { target: "_blank", rel: "noreferrer" }
                      : {})}
                    className="text-muted transition-colors hover:text-fg"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-border-soft">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-[11px] text-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © 2026 {site.author}. Source-available under the{" "}
            <Link
              href={site.license.url}
              target="_blank"
              rel="noreferrer"
              className="text-muted underline underline-offset-2 hover:text-fg"
            >
              {site.license.name}
            </Link>
            .
          </p>
          <p>
            Commercial use requires a separate licence —{" "}
            <Link
              href={`mailto:${site.email}`}
              className="text-muted underline underline-offset-2 hover:text-fg"
            >
              {site.email}
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
