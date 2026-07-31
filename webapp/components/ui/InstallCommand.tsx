"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { installCommands } from "@/lib/site";

export function InstallCommand() {
  const [active, setActive] = useState<string>(installCommands[0].id);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const current = installCommands.find((entry) => entry.id === active) ?? installCommands[0];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current.command);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the command stays selectable by hand.
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-terminal-border bg-terminal">
      <div className="flex items-center gap-1 border-b border-terminal-border px-2 py-2">
        {installCommands.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setActive(entry.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              entry.id === active
                ? "bg-terminal-soft text-terminal-fg"
                : "text-slate-500 hover:text-terminal-fg"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex items-start gap-3 px-4 py-3.5 font-mono text-[13px]">
        <span className="select-none pt-px text-terminal-accent" aria-hidden>
          $
        </span>
        <code className="min-w-0 flex-1 break-all text-terminal-fg">{current.command}</code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-terminal-soft hover:text-terminal-fg"
          aria-label={copied ? "Copied" : "Copy install command"}
        >
          {copied ? (
            <Check className="size-4 text-terminal-accent" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}
