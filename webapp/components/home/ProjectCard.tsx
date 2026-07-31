import { Mail, Scale } from "lucide-react";
import Link from "next/link";

import { GitHubIcon } from "@/components/ui/icons/GitHubIcon";
import { site } from "@/lib/site";

export function ProjectCard() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
      <div className="rounded-3xl border border-terminal-border bg-terminal p-8 sm:p-12">
        <div className="max-w-2xl space-y-4">
          <span className="font-mono text-[11px] uppercase tracking-widest text-terminal-accent">
            The project
          </span>
          <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
            Source-available, not open source.
          </h2>
          <p className="text-sm leading-relaxed text-slate-300">
            <strong className="font-semibold text-white">shoots</strong> is licensed under the{" "}
            {site.license.name}. You are free to read, use, modify and share the source code — but
            only for noncommercial purposes. Any commercial use of the software, in whole or in
            part, is not permitted under this license.
          </p>
          <p className="text-sm leading-relaxed text-slate-300">
            Copyright © 2026 {site.author}. All commercial rights are reserved by the copyright
            holder.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link
              href={site.repo}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-terminal-accent px-4 py-2 text-xs font-bold text-slate-950 transition-opacity hover:opacity-90"
            >
              <GitHubIcon />
              Repository
            </Link>
            <Link
              href={site.license.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-terminal-border bg-terminal-soft px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:text-white"
            >
              <Scale className="size-4" aria-hidden />
              Read the license
            </Link>
            <Link
              href={`mailto:${site.email}`}
              className="inline-flex items-center gap-2 rounded-xl border border-terminal-border bg-terminal-soft px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:text-white"
            >
              <Mail className="size-4 text-terminal-accent" aria-hidden />
              Commercial licensing
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
