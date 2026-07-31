"use client";

import { useState } from "react";

const steps = [
  {
    id: "init",
    command: "shoots develop init ~/Catalogs/2025",
    title: "Learn your style",
    when: "Once, from a catalog you have already developed",
    body: "Exports a training dataset from your edited photos and fits a develop profile. Under the hood: export --edited-only + train.",
    writes: "~/.shoots/develop/profile/export.json",
  },
  {
    id: "edit",
    command: "shoots develop edit ~/Shoots/2026-07-19",
    title: "Develop a new shoot",
    when: "Per shoot, before you open your editor",
    body: "Predicts a develop vector per image and writes it as an .xmp sidecar next to the photograph. Nothing else is touched.",
    writes: ".xmp sidecars next to each RAW",
  },
  {
    id: "refine",
    command: "shoots develop refine ~/Shoots/2026-07-19",
    title: "Close the loop",
    when: "After you have developed them in your editor",
    body: "Measures how much of the prediction you kept, refits on that shoot weighted by how much you changed, and corrects the constant offset. That is feedback + learn + calibrate, in order.",
    writes: "feedback.jsonl — the one file that cannot be rebuilt",
  },
  {
    id: "clean",
    command: "shoots develop clean",
    title: "Tidy up",
    when: "When the per-shoot working files pile up",
    body: "Drops the intermediate per-shoot exports and predictions. Your feedback history is never touched.",
    writes: "nothing you need again",
  },
];

export function DevelopLoop() {
  const [active, setActive] = useState(0);
  const step = steps[active];

  return (
    <div className="overflow-hidden rounded-2xl border border-border-base bg-surface">
      <div className="grid gap-px bg-border-soft sm:grid-cols-4">
        {steps.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setActive(index)}
            className={`px-4 py-3.5 text-left transition-colors ${
              index === active ? "bg-fg text-bg" : "bg-surface hover:bg-surface-muted"
            }`}
          >
            <span
              className={`font-mono text-[10px] font-bold uppercase tracking-widest ${
                index === active ? "text-accent" : "text-subtle"
              }`}
            >
              Step {index + 1}
            </span>
            <span
              className={`mt-1 block font-mono text-[13px] font-semibold ${
                index === active ? "text-bg" : "text-fg"
              }`}
            >
              {item.id}
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-5 p-5 md:grid-cols-[1.1fr_1fr] md:items-center">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-subtle">
            {step.when}
          </p>
          <h3 className="text-lg font-bold text-fg">{step.title}</h3>
          <p className="text-[13px] leading-relaxed text-muted">{step.body}</p>
        </div>

        <div className="rounded-xl border border-terminal-border bg-terminal p-4 font-mono text-[12px]">
          <div className="flex items-start gap-2">
            <span className="text-terminal-accent" aria-hidden>
              $
            </span>
            <code className="break-all text-terminal-fg">{step.command}</code>
          </div>
          <p className="mt-3 border-t border-terminal-border pt-3 text-[11px] text-slate-400">
            writes <span className="text-slate-300">{step.writes}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
