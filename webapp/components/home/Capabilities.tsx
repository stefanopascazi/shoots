import { Brain, HardDriveDownload, Sparkles, Star, Tags, Target } from "lucide-react";
import Link from "next/link";

import { SectionHeading } from "@/components/home/SectionHeading";

const capabilities = [
  {
    icon: HardDriveDownload,
    command: "shoots import",
    title: "Offload and rename",
    body: "Copy a card into a dated catalog, checksum-verified. Original filenames are kept unless you ask for a template.",
    href: "/docs/commands/import",
  },
  {
    icon: Tags,
    command: "shoots exif",
    title: "Stamp metadata",
    body: "Artist, copyright, keywords — any EXIF·IPTC·XMP tag — written across a whole folder in one pass.",
    href: "/docs/commands/exif",
  },
  {
    icon: Target,
    command: "shoots cull",
    title: "Cull the out-of-focus frames",
    body: "Focus-aware blur detection, shallow depth of field included, with an optional human-in-the-loop review.",
    href: "/docs/commands/cull",
  },
  {
    icon: Star,
    command: "shoots rate",
    title: "Star-rate and keyword",
    body: "0–5 stars and keyword suggestions from a local ONNX CLIP model, written as XMP sidecars your editor reads.",
    href: "/docs/commands/rate",
  },
  {
    icon: Brain,
    command: "shoots match",
    title: "Learn your eye",
    body: "Duel your own photos two at a time; the outcomes train a rating profile that generalizes your taste to work you have never judged.",
    href: "/docs/commands/match",
  },
  {
    icon: Sparkles,
    command: "shoots develop",
    title: "Learn your edit",
    body: "Fit a predictor on a catalog you have already developed, and get a per-image starting point as an XMP sidecar.",
    href: "/docs/develop-predictor",
  },
];

export function Capabilities() {
  return (
    <section className="border-b border-border-soft bg-bg-muted">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <SectionHeading
          eyebrow="What it does"
          title="Six jobs, one binary"
          description="Each one is a standalone command. Run them by hand, chain them in a script, or drive them from the interactive shell."
        />

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((capability) => (
            <Link
              key={capability.command}
              href={capability.href}
              className="group flex flex-col gap-2.5 rounded-2xl border border-border-base bg-surface p-5 transition-colors hover:border-subtle"
            >
              <span className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-fg">
                <capability.icon className="size-4" aria-hidden />
              </span>
              <code className="font-mono text-[11px] text-subtle">{capability.command}</code>
              <h3 className="text-[15px] font-bold text-fg">{capability.title}</h3>
              <p className="text-[13px] leading-relaxed text-muted">{capability.body}</p>
              <span className="mt-auto pt-2 text-xs font-semibold text-link group-hover:text-link-hover">
                Read the docs →
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
