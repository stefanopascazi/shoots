# Core concepts

The rules below hold for **every** command. Learn them once and the whole CLI
becomes predictable.

---

## 1. Non-destructive by default

Originals are never mutated or deleted. Concretely:

| Command | What it does to your originals |
| --- | --- |
| `import` | Copies. `--move` deletes a source **only after** its copy's SHA-256 matches. |
| `rename` | Renames in place, two-phase, never overwriting an existing name. |
| `exif` | Writes tags but keeps exiftool's `*_original` backups (unless `--overwrite-original`). |
| `cull` | Keepers are never touched. Rejects are relocated to `--dest`. Nothing is deleted. |
| `rate` | Writes sidecars next to the file; refuses to overwrite an existing `.xmp`. |
| `embeddings` | Read-only on your photos; writes only into `--out`. |
| `develop` | Read-only on your photos; writes datasets, profiles and `.xmp` sidecars. |

There is no `shoots delete`, and no command removes an original file.

---

## 2. `--dry-run` on every mutating command

`--dry-run` runs the full analysis and prints the exact plan, then stops before
touching the filesystem. Use it as the default first step of anything new.

```sh
shoots import E:/DCIM --dest ./raw --dry-run
shoots rename ./raw --pattern "{date}_{seq:4}.{ext}" --dry-run
shoots exif ./raw --set-artist "Jane Doe" --dry-run
shoots cull ./raw --dest ./rejects --dry-run
shoots rate ./raw --dry-run
```

Note that `cull --dry-run` still *analyzes* (that is the expensive part) — it just
skips relocating files and writing the `--out` report.

---

## 3. stdout is the result, stderr is the noise

| Stream | Carries |
| --- | --- |
| **stdout** | The command's actual result: human table, or the `--json` document |
| **stderr** | Logs, warnings, errors, progress bars, `--verbose` output |

This means `--json` output is always safely pipeable:

```sh
shoots cull ./raw --json | jq '.results[] | select(.verdict == "blurry") | .file'
```

In `--json` mode, human result lines are suppressed entirely so stdout contains
exactly one JSON document.

---

## 4. Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success — everything the command attempted worked |
| `1` | One or more per-file operations failed (partial success is still reported) |
| `2` | Bad usage — invalid flag value, unknown profile, missing prerequisite |

A command that processes 500 files and fails on 3 exits `1` **and still reports
the 497 successes**. It does not abort the batch on the first error.

```sh
shoots import E:/DCIM --dest ./raw --json || notify-failure
```

---

## 5. `--json` everywhere it matters

Every command that produces a result supports `--json`. The shape is consistent:

```jsonc
{
  "command": "cull",          // which command produced this
  "dryRun": false,            // mutating commands echo their mode
  "results": [ /* per-file records */ ],
  "errors":  [ { "file": "...", "error": "..." } ],
  "summary": { "total": 482, "sharp": 431, "blurry": 51, "failed": 0 }
}
```

`errors` is always present and always an array — an empty one when nothing failed.
`summary` always carries a `total` and a `failed`.

---

## 6. File discovery

Every command takes a **path** that may be a directory or a single file.
Directories are scanned recursively (except `rename`, which needs `--recursive`
explicitly, and `exif`, which recurses unless you pass `--no-recursive`).

Results are **sorted by path**, so runs are deterministic.
Hidden entries (dot-prefixed) are skipped.

### Recognized extensions

**RAW** — `3fr` `arw` `cr2` `cr3` `dcr` `dng` `erf` `fff` `iiq` `kdc` `mef` `mos`
`nef` `nrw` `orf` `pef` `raf` `raw` `rw2` `rwl` `srw` `x3f`

**Processed** — `jpg` `jpeg` `png` `tif` `tiff` `webp`

Anything else is ignored. This is why pointing `shoots` at a folder containing
sidecars, XMPs and `.DS_Store` files is harmless.

### RAW handling

RAW files are **never demosaiced**. Wherever pixels are needed (`cull` scoring,
`rate` embeddings, `embeddings` previews), `shoots` extracts the **embedded JPEG
preview** with exiftool. It is fast, it is what the camera itself judged the frame
to look like, and it avoids shipping a RAW engine.

The one exception is `develop export --baseline external`, which deliberately
wants a *neutral* render and shells out to LibRaw's `dcraw_emu`.

---

## 7. Concurrency

Commands that do per-file work accept `--concurrency <n>` (default `4`). This
bounds parallel file operations / analyses / inference jobs.

- I/O-bound work (`import` off a slow card): raising it rarely helps; the card is
  the bottleneck.
- CPU-bound work (`cull`, `rate`): match it to your core count.
- Constrained machines: lower it. ONNX inference holds real memory per job.

---

## 8. Everything runs headless

There is **no GUI dependency**. The interactive Ink progress UI activates only on
a TTY; in a pipe, a cron job or CI you get plain log lines on stderr and the same
result on stdout.

The single exception is `cull --review`, which drives a live UI and therefore
requires the interactive shell. It refuses with exit code `2` in batch mode, and
tells you so.

---

## 9. External dependencies live in `~/.shoots`

Nothing third-party is bundled into the binary. exiftool, LibRaw and the ONNX
model are downloaded at runtime, verified against a pinned SHA-256, into
`~/.shoots` (uniform across all OSes; override with `SHOOTS_HOME`).

This is a licensing and a size decision: the binary stays lean, and every external
component's license is vetted for commercial redistribution before it is adopted.

See [Configuration](./configuration.md) for the full directory layout.

---

## 10. Package architecture

```
packages/
  cli/        Commander commands + Ink shell. The only package that knows about terminals.
  core/       Pipeline engine, templating, file discovery, job queue, checksums, provisioning.
  imaging/    exiftool wrapper, sharp thumbnails, Laplacian blur + focus-map analysis.
  inference/  QualityModel interface, ONNX CLIP backend, aesthetics, keywords, profiles.
```

Dependency direction: `cli → core / imaging / inference`, and `imaging → core`.

`core`, `imaging` and `inference` never depend on `cli` or Ink. They are usable
headlessly, from a library, or from a future REST layer, unchanged.
