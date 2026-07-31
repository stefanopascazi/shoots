import { FileCode, Lock, ShieldCheck, SquareTerminal } from "lucide-react";

const principles = [
  {
    icon: ShieldCheck,
    title: "Nothing is ever deleted",
    body: "Originals stay untouched and edits go to sidecars. Rejects are moved, never removed; a failed checksum deletes the corrupt copy, never the source.",
  },
  {
    icon: Lock,
    title: "Everything runs locally",
    body: "No cloud, no upload, no subscription. The CLIP model and the develop predictor run on your machine, from ~/.shoots.",
  },
  {
    icon: FileCode,
    title: "Editor-agnostic",
    body: "XMP sidecars are the interface. Lightroom, Bridge and Capture One read them — no host editor has to be installed for the engine to run.",
  },
  {
    icon: SquareTerminal,
    title: "Built to be scripted",
    body: "Every command speaks --json and honours --dry-run, with meaningful exit codes, so it drops straight into scripts, cron and CI.",
  },
];

export function Principles() {
  return (
    <section className="border-b border-border-soft">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-14 sm:px-6 md:grid-cols-2 lg:grid-cols-4">
        {principles.map((principle) => (
          <div key={principle.title} className="space-y-2">
            <principle.icon className="size-5 text-accent" aria-hidden />
            <h3 className="text-sm font-bold text-fg">{principle.title}</h3>
            <p className="text-[13px] leading-relaxed text-muted">{principle.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
