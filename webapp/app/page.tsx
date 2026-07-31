import Link from "next/link";

import { Capabilities } from "@/components/home/Capabilities";
import { CommandMap } from "@/components/home/CommandMap";
import { DevelopLoop } from "@/components/home/DevelopLoop";
import { FocusCullDemo } from "@/components/home/FocusCullDemo";
import { Hero } from "@/components/home/Hero";
import { Principles } from "@/components/home/Principles";
import { ProjectCard } from "@/components/home/ProjectCard";
import { Screens } from "@/components/home/Screens";
import { SectionHeading } from "@/components/home/SectionHeading";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Principles />
      <Capabilities />

      <section className="border-b border-border-soft">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <SectionHeading
            eyebrow="Focus-aware culling"
            title="A shallow-DoF portrait is mostly bokeh"
            description="A single global sharpness number throws away your best wide-open frames. Alongside it, cull builds a focus map over a tile grid and takes the sharpest region: a frame below --threshold is still kept when that peak clears --focus-threshold. Move the sliders and watch the verdicts change."
          />

          <div className="mt-10">
            <FocusCullDemo />
          </div>

          <p className="mt-4 text-xs text-subtle">
            Classic computer vision — Laplacian variance plus a tile-based focus map. No model, no
            inference.{" "}
            <Link
              href="/docs/commands/cull"
              className="font-semibold text-link hover:text-link-hover"
            >
              How the scoring works →
            </Link>
          </p>
        </div>
      </section>

      <section className="border-b border-border-soft bg-bg-muted">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <SectionHeading
            eyebrow="Develop predictor"
            title="Your own develop style, learned and re-applied"
            description="It learns the global look from a catalog you have already developed and writes a per-image starting point as an XMP sidecar. It does not do local masks, generative edits or a finished image — the goal is the best starting point to refine."
          />

          <div className="mt-10">
            <DevelopLoop />
          </div>

          <p className="mt-4 text-xs text-subtle">
            Every step accepts <code className="font-mono text-muted">--dry-run</code>.{" "}
            <Link
              href="/docs/develop-predictor"
              className="font-semibold text-link hover:text-link-hover"
            >
              Read the predictor guide →
            </Link>
          </p>
        </div>
      </section>

      <CommandMap />

      <section className="border-b border-border-soft">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <SectionHeading
            eyebrow="In the terminal"
            title="What it actually looks like"
            description="Terminal captures generated from real runs — the interactive UIs driven by keystrokes, the batch commands actually executed."
          />

          <div className="mt-10">
            <Screens />
          </div>
        </div>
      </section>

      <ProjectCard />
    </>
  );
}
