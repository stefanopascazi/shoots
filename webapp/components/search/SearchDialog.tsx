"use client";

import { CornerDownLeft, FileText, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { searchDocs, type SearchEntry } from "@/lib/search";

interface SearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SearchDialog({ isOpen, onClose }: SearchDialogProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<SearchEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  // The corpus is fetched once, the first time the dialog is opened.
  useEffect(() => {
    if (!isOpen || entries) return;
    let cancelled = false;
    fetch("/search-index.json")
      .then((response) => response.json())
      .then((data: SearchEntry[]) => {
        if (!cancelled) setEntries(data);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, entries]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
    else {
      setQuery("");
      setCursor(0);
    }
  }, [isOpen]);

  const results = useMemo(
    () => (entries ? searchDocs(entries, query) : []),
    [entries, query],
  );

  useEffect(() => setCursor(0), [query]);

  if (!isOpen) return null;

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") return onClose();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((index) => Math.min(index + 1, results.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter" && results[cursor]) {
      event.preventDefault();
      go(results[cursor].href);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search the documentation"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
    >
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm"
      />

      <div
        className="relative flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-base bg-surface shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-border-soft px-4 py-3">
          <Search className="size-4 shrink-0 text-subtle" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands, flags, guides…"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-subtle focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-subtle transition-colors hover:text-fg"
            aria-label="Close search"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {query.trim().length < 2 ? (
            <p className="px-3 py-6 text-center text-xs text-subtle">
              Type at least two characters to search the documentation.
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-subtle">
              {entries === null ? "Loading index…" : `No results for “${query}”.`}
            </p>
          ) : (
            <ul className="space-y-1">
              {results.map((result, index) => (
                <li key={`${result.href}-${index}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => go(result.href)}
                    className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      index === cursor ? "bg-surface-muted" : "hover:bg-surface-muted"
                    }`}
                  >
                    <FileText className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-semibold text-fg">
                          {result.section ?? result.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-subtle">
                          {result.section ? result.title : result.group}
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted">
                        {result.snippet}
                      </span>
                    </span>
                    {index === cursor && (
                      <CornerDownLeft className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border-soft px-4 py-2 text-[11px] text-subtle">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-base px-1">↑</kbd>
            <kbd className="rounded border border-border-base px-1">↓</kbd> to navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-base px-1">↵</kbd> to open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-base px-1">esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
