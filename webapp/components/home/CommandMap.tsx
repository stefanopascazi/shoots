import Link from "next/link";

import { SectionHeading } from "@/components/home/SectionHeading";
import { CommandBlock } from "@/components/ui/CommandBlock";

const tour = [
  {
    comment: "Install external tools and the AI model into ~/.shoots",
    command: "shoots setup",
  },
  {
    comment: "Offload a card into a dated catalog, checksum-verified",
    command: "shoots import E:/DCIM/100CANON --dest D:/Shoots/2026/smith-wedding",
  },
  {
    comment: "Stamp studio metadata onto everything",
    command:
      'shoots exif D:/Shoots/2026/smith-wedding --set-artist "Jane Doe Photography" --set-copyright "© 2026 Jane Doe"',
  },
  {
    comment: "Move the out-of-focus frames out of the way (keepers stay put)",
    command:
      "shoots cull D:/Shoots/2026/smith-wedding --dest D:/Shoots/2026/smith-wedding/rejects",
  },
  {
    comment: "Star-rate what is left, as XMP sidecars Lightroom will read",
    command: "shoots rate D:/Shoots/2026/smith-wedding --profile wedding --write-xmp",
  },
];

const commands: { name: string; slug?: string; blurb: string; children?: string[] }[] = [
  { name: "import", slug: "import", blurb: "card → catalog, renamed and SHA-256 verified" },
  { name: "rename", slug: "rename", blurb: "in-place batch rename with the same template engine" },
  { name: "exif", slug: "exif", blurb: "batch read/write EXIF·IPTC·XMP via exiftool" },
  { name: "cull", slug: "cull", blurb: "focus-aware blur detection; relocate or review rejects" },
  { name: "rate", slug: "rate", blurb: "0–5 star ratings + keywords via the ONNX CLIP model" },
  {
    name: "embeddings",
    slug: "embeddings",
    blurb: "profile-neutral CLIP export for preference learning",
  },
  {
    name: "match",
    slug: "match",
    blurb: "learn your eye from duels → a personal rating profile",
    children: ["import", "serve", "train"],
  },
  {
    name: "develop",
    slug: "develop",
    blurb: "personal develop-setting predictor",
    children: ["init", "edit", "refine", "export", "train", "predict", "calibrate", "diagnose"],
  },
  { name: "schedule", slug: "schedule", blurb: "run develop refine daily and unattended" },
  { name: "setup", slug: "setup", blurb: "provision exiftool + LibRaw + the inference model" },
  { name: "doctor", slug: "doctor", blurb: "environment health check" },
  { name: "update", slug: "update", blurb: "self-update the standalone binary" },
  { name: "shell", blurb: "the interactive shell (default with no arguments)" },
];

export function CommandMap() {
  return (
    <section className="border-b border-border-soft bg-bg-muted">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <SectionHeading
          eyebrow="The surface"
          title="The 60-second tour"
          description="Every mutating command accepts --dry-run. Every command accepts --json. Nothing is ever deleted."
        />

        <div className="mt-10 grid gap-6 lg:grid-cols-[1.05fr_1fr] lg:items-start">
          <CommandBlock title="a full shoot, start to finish" lines={tour} />

          <div className="rounded-2xl border border-border-base bg-surface p-5">
            <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-subtle">
              Command map
            </h3>
            <ul className="mt-3 divide-y divide-border-soft">
              {commands.map((command) => (
                <li key={command.name} className="py-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {command.slug ? (
                      <Link
                        href={`/docs/commands/${command.slug}`}
                        className="font-mono text-[13px] font-semibold text-fg underline-offset-4 hover:text-link hover:underline"
                      >
                        {command.name}
                      </Link>
                    ) : (
                      <span className="font-mono text-[13px] font-semibold text-fg">
                        {command.name}
                      </span>
                    )}
                    <span className="text-xs text-muted">{command.blurb}</span>
                  </div>
                  {command.children && (
                    <p className="mt-1 font-mono text-[11px] text-subtle">
                      └─ {command.children.join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <Link
              href="/docs/commands"
              className="mt-4 inline-block text-xs font-semibold text-link hover:text-link-hover"
            >
              Full command reference →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
