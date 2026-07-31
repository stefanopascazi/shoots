"use client";

import Image, { type StaticImageData } from "next/image";
import { useState } from "react";

import cullScreen from "@/public/assets/screens/cull.png";
import doctorScreen from "@/public/assets/screens/doctor.png";
import mentionsScreen from "@/public/assets/screens/mentions.png";
import paletteScreen from "@/public/assets/screens/palette.png";
import rateScreen from "@/public/assets/screens/rate.png";
import reviewScreen from "@/public/assets/screens/review.png";
import shellScreen from "@/public/assets/screens/shell.png";

interface Screen {
  id: string;
  label: string;
  caption: string;
  image: StaticImageData;
}

// Captions mirror assets/screens/README.md — every capture is real output.
const screens: Screen[] = [
  {
    id: "shell",
    label: "shell",
    caption: "The interactive shell as it opens: wordmark, environment line, empty prompt.",
    image: shellScreen,
  },
  {
    id: "palette",
    label: "/ palette",
    caption: 'Typing "/" opens the command palette with live autocomplete.',
    image: paletteScreen,
  },
  {
    id: "mentions",
    label: "@ mentions",
    caption: 'Typing "@" completes real paths from the filesystem.',
    image: mentionsScreen,
  },
  {
    id: "cull",
    label: "cull",
    caption: "A real focus-aware cull run: per-frame scores and the summary line.",
    image: cullScreen,
  },
  {
    id: "review",
    label: "review",
    caption: "Human-in-the-loop review of the uncertain shallow-DoF rescues.",
    image: reviewScreen,
  },
  {
    id: "rate",
    label: "rate",
    caption: "Local CLIP scoring: stars and keywords written to sidecars.",
    image: rateScreen,
  },
  {
    id: "doctor",
    label: "doctor",
    caption: "Environment health check: tools and model provisioned under ~/.shoots.",
    image: doctorScreen,
  },
];

export function Screens() {
  const [active, setActive] = useState(0);
  const screen = screens[active];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {screens.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setActive(index)}
            className={`rounded-full px-3.5 py-1.5 font-mono text-xs transition-colors ${
              index === active
                ? "bg-fg text-bg"
                : "border border-border-base text-muted hover:text-fg"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <figure className="overflow-hidden rounded-2xl border border-terminal-border bg-terminal shadow-xl">
        <Image
          src={screen.image}
          alt={screen.caption}
          className="h-auto w-full"
          placeholder="blur"
        />
        <figcaption className="border-t border-terminal-border px-4 py-3 text-[11px] text-slate-400">
          {screen.caption}
        </figcaption>
      </figure>
    </div>
  );
}
