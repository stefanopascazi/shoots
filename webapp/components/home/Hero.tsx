import { ArrowRight, BookOpen, CircleCheck } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { InstallCommand } from "@/components/ui/InstallCommand";
import { site } from "@/lib/site";

import runScreen from "@/public/assets/screens/run.png";

const guarantees = [
  "Nothing is ever deleted or overwritten",
  "Everything runs locally — no cloud, no upload",
  "Every command speaks --json and honours --dry-run",
];

export function Hero() {
  return (
    <section className="border-b border-border-soft">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:items-center lg:py-20">
        <div className="space-y-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-border-base bg-surface-muted px-3 py-1 text-[11px] font-semibold text-muted">
            <span className="font-mono text-accent">v{site.version}</span>
            <span className="text-subtle" aria-hidden>
              ·
            </span>
            <span>Standalone binary — no Node.js required</span>
          </span>

          <h1 className="text-4xl font-extrabold leading-[1.1] tracking-tight text-fg sm:text-5xl">
            Batch automation for professional{" "}
            <span className="text-accent">photography workflows</span>.
          </h1>

          <p className="max-w-xl text-base leading-relaxed text-muted">
            <strong className="font-semibold text-fg">shoots</strong> is a CLI for photographers
            who shoot a lot and edit in Lightroom, Capture One or anything else. It is not an
            editor and not a catalog: it sits before and after your editor and automates the
            boring parts of a shoot.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/docs/getting-started"
              className="inline-flex items-center gap-2 rounded-full bg-fg px-5 py-2.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90"
            >
              <BookOpen className="size-4" aria-hidden />
              Get started
              <ArrowRight className="size-4 opacity-60" aria-hidden />
            </Link>
            <Link
              href="/docs/commands"
              className="inline-flex items-center gap-2 rounded-full border border-border-base px-5 py-2.5 text-sm font-medium text-muted transition-colors hover:text-fg"
            >
              Command reference
            </Link>
          </div>

          <div className="max-w-xl pt-1">
            <InstallCommand />
          </div>

          <ul className="grid gap-2 pt-1 text-xs text-muted">
            {guarantees.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <CircleCheck className="size-4 shrink-0 text-accent" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative">
          <div className="overflow-hidden rounded-2xl border border-terminal-border bg-terminal shadow-2xl">
            <div className="flex items-center gap-1.5 border-b border-terminal-border px-4 py-3">
              <span className="size-2.5 rounded-full bg-red-500/80" aria-hidden />
              <span className="size-2.5 rounded-full bg-amber-400/80" aria-hidden />
              <span className="size-2.5 rounded-full bg-emerald-400/80" aria-hidden />
              <span className="ml-3 font-mono text-[11px] text-slate-500">
                shoots — interactive shell
              </span>
            </div>
            <Image
              src={runScreen}
              alt="A cull run executed from the shoots interactive shell, with per-frame sharpness scores streaming into the scrollback"
              className="h-auto w-full"
              priority
            />
          </div>
          <p className="mt-3 text-center text-[11px] text-subtle">
            Real terminal capture — every screenshot on this page is generated from actual output.
          </p>
        </div>
      </div>
    </section>
  );
}
