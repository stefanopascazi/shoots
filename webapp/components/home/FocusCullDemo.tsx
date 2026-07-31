"use client";

import { useState } from "react";

interface Frame {
  file: string;
  aperture: string;
  score: number;
  focusPeak: number;
  /** Normalised tile map (5×4); the maximum tile is the focus peak. */
  pattern: number[];
  note: string;
}

// Scores are the ones printed in the `shoots cull` reference output; the tile
// maps illustrate how the same numbers are distributed across the frame.
const frames: Frame[] = [
  {
    file: "IMG_0001.CR3",
    aperture: "f/2.8",
    score: 412.83,
    focusPeak: 891.2,
    note: "Detail everywhere — sharp on the global score alone.",
    pattern: [
      0.62, 0.71, 0.85, 0.78, 0.66, 0.74, 0.93, 1, 0.96, 0.7, 0.69, 0.88, 0.95, 0.83, 0.64, 0.55,
      0.63, 0.72, 0.61, 0.5,
    ],
  },
  {
    file: "IMG_0002.CR3",
    aperture: "f/1.4",
    score: 78.14,
    focusPeak: 623.55,
    note: "Mostly bokeh: the global score is low, but the eyes are tack sharp.",
    pattern: [
      0.08, 0.1, 0.14, 0.11, 0.07, 0.12, 0.4, 1, 0.86, 0.13, 0.1, 0.22, 0.35, 0.24, 0.09, 0.06,
      0.08, 0.12, 0.09, 0.05,
    ],
  },
  {
    file: "IMG_0003.CR3",
    aperture: "f/2.8",
    score: 31.02,
    focusPeak: 44.18,
    note: "Soft everywhere — missed focus or motion blur. No region to rescue.",
    pattern: [
      0.55, 0.62, 0.7, 0.66, 0.58, 0.64, 0.8, 0.92, 1, 0.61, 0.6, 0.75, 0.86, 0.72, 0.57, 0.5,
      0.56, 0.63, 0.55, 0.48,
    ],
  },
];

interface Verdict {
  label: "sharp" | "sharp*" | "blurry";
  rescued: boolean;
}

/** The rule implemented by `shoots cull`: the rescue only ever moves blurry → sharp. */
function classify(
  frame: Frame,
  threshold: number,
  focusThreshold: number,
  rescueEnabled: boolean,
): Verdict {
  if (frame.score >= threshold) return { label: "sharp", rescued: false };
  if (rescueEnabled && frame.focusPeak >= focusThreshold) {
    return { label: "sharp*", rescued: true };
  }
  return { label: "blurry", rescued: false };
}

const verdictStyles: Record<Verdict["label"], string> = {
  sharp: "text-terminal-accent",
  "sharp*": "text-cyan-300",
  blurry: "text-red-400",
};

export function FocusCullDemo() {
  const [threshold, setThreshold] = useState(100);
  const [focusThreshold, setFocusThreshold] = useState(250);
  const [rescueEnabled, setRescueEnabled] = useState(true);
  const [selected, setSelected] = useState(1);

  const frame = frames[selected];
  const verdicts = frames.map((item) => classify(item, threshold, focusThreshold, rescueEnabled));
  const sharpCount = verdicts.filter((verdict) => verdict.label !== "blurry").length;
  const rescuedCount = verdicts.filter((verdict) => verdict.rescued).length;

  const tiles = frame.pattern.map((weight) => weight * frame.focusPeak);

  const flags = [
    `--threshold ${threshold}`,
    `--focus-threshold ${focusThreshold}`,
    rescueEnabled ? "" : "--no-focus-rescue",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="overflow-hidden rounded-2xl border border-border-base bg-surface">
      <div className="grid lg:grid-cols-[1.05fr_1fr]">
        {/* Focus map */}
        <div className="border-b border-border-soft p-5 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2">
            {frames.map((item, index) => (
              <button
                key={item.file}
                type="button"
                onClick={() => setSelected(index)}
                className={`rounded-full px-3 py-1 font-mono text-[11px] transition-colors ${
                  index === selected
                    ? "bg-fg text-bg"
                    : "border border-border-base text-muted hover:text-fg"
                }`}
              >
                {item.file}
              </button>
            ))}
          </div>

          <div className="mt-4 rounded-xl border border-terminal-border bg-terminal p-3">
            <div className="grid grid-cols-5 gap-1">
              {tiles.map((value, index) => {
                const isPeak = value >= focusThreshold;
                const isMid = !isPeak && value >= threshold;
                return (
                  <div
                    key={index}
                    className={`flex aspect-4/3 items-end justify-end rounded p-1 font-mono text-[9px] transition-colors ${
                      isPeak
                        ? "bg-emerald-500/30 text-emerald-200 ring-1 ring-emerald-400/60"
                        : isMid
                          ? "bg-amber-500/15 text-amber-200/80 ring-1 ring-amber-400/30"
                          : "bg-slate-800/40 text-slate-500 ring-1 ring-slate-700/40"
                    }`}
                  >
                    {Math.round(value)}
                  </div>
                );
              })}
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-terminal-border pt-3 font-mono text-[11px]">
              <span className="text-slate-400">
                global <span className="text-terminal-fg">{frame.score.toFixed(2)}</span>
              </span>
              <span className="text-slate-400">
                focus peak{" "}
                <span className="text-terminal-fg">{frame.focusPeak.toFixed(2)}</span>
              </span>
              <span className="text-slate-400">{frame.aperture}</span>
            </div>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-muted">{frame.note}</p>
        </div>

        {/* Controls + report */}
        <div className="space-y-5 p-5">
          <div className="space-y-4">
            <Slider
              label="--threshold"
              hint="Global Laplacian variance below this counts as blurry"
              value={threshold}
              min={50}
              max={200}
              step={5}
              onChange={setThreshold}
            />
            <Slider
              label="--focus-threshold"
              hint="Keep a soft frame when its sharpest region clears this"
              value={focusThreshold}
              min={100}
              max={900}
              step={10}
              onChange={setFocusThreshold}
              disabled={!rescueEnabled}
            />

            <label className="flex items-center gap-2.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={!rescueEnabled}
                onChange={(event) => setRescueEnabled(!event.target.checked)}
                className="size-3.5 accent-current"
              />
              <span>
                <code className="font-mono text-fg">--no-focus-rescue</code> — classify on the
                global score only
              </span>
            </label>
          </div>

          <div className="overflow-x-auto rounded-xl border border-terminal-border bg-terminal p-3 font-mono text-[11px] leading-relaxed">
            <div className="text-slate-500">$ shoots cull ./raw {flags}</div>
            <div className="mt-2 grid grid-cols-[4.5rem_5rem_5rem_3rem_1fr] gap-x-2 text-slate-500">
              <span>verdict</span>
              <span className="text-right">score</span>
              <span className="text-right">focus</span>
              <span>aper</span>
              <span>file</span>
            </div>
            {frames.map((item, index) => (
              <div
                key={item.file}
                className={`grid grid-cols-[4.5rem_5rem_5rem_3rem_1fr] gap-x-2 ${
                  index === selected ? "" : "opacity-60"
                }`}
              >
                <span className={verdictStyles[verdicts[index].label]}>
                  {verdicts[index].label}
                </span>
                <span className="text-right text-slate-300">{item.score.toFixed(2)}</span>
                <span className="text-right text-slate-300">{item.focusPeak.toFixed(2)}</span>
                <span className="text-slate-400">{item.aperture}</span>
                <span className="truncate text-slate-400">./raw/{item.file}</span>
              </div>
            ))}
            <div className="mt-2 border-t border-terminal-border pt-2 text-slate-400">
              3 analyzed @ threshold {threshold}: {sharpCount} sharp ({rescuedCount} rescued),{" "}
              {3 - sharpCount} blurry, 0 failed
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SliderProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function Slider({ label, hint, value, min, max, step, disabled, onChange }: SliderProps) {
  return (
    <div className={disabled ? "opacity-40" : undefined}>
      <div className="flex items-baseline justify-between gap-3">
        <code className="font-mono text-xs font-semibold text-fg">{label}</code>
        <span className="font-mono text-xs text-accent">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1.5 w-full accent-emerald-600"
        aria-label={label}
      />
      <p className="mt-0.5 text-[11px] text-subtle">{hint}</p>
    </div>
  );
}
