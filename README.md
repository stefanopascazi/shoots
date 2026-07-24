# shoots

Scriptable batch automation for professional photography workflows.

`shoots` is an **orchestration layer**, not an editor and not a DAM. It sits *before* or *after* Lightroom / Capture One / your culling tool of choice and automates the tedious parts around them — the way Fastlane orchestrates mobile builds without replacing Xcode:

- **Scriptable** — clean stdout, `--json` everywhere it matters, sensible exit codes (`0` ok, `1` failures, `2` bad usage), `--dry-run` on every mutating command.
- **Non-destructive by default** — originals are never mutated or deleted. Imports are checksum-verified copies; culling copies into subfolders; ratings go to sidecars; metadata writes keep exiftool's `_original` backups.
- **Headless-friendly** — no GUI dependency; works in cron, CI, and watch-folder setups. The interactive Ink progress UI only activates on a TTY.
- **Pipeline-as-code** — declarative YAML pipelines you can version and share across a studio (see `examples/wedding-pipeline.yaml`).
- **Extensible toward ML** — a clean inference seam (`@shoots/inference`) designed for a future local ONNX backend without touching the rest of the code.

## Install

Standalone binary for your platform — no Node.js required.

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.ps1 | iex
```

The installer downloads the latest release for your OS/arch, verifies its SHA-256, installs it to `~/.shoots/bin` (`%USERPROFILE%\.shoots\bin` on Windows) and adds it to your `PATH`. Override the target with `SHOOTS_INSTALL_DIR`.

Then finish setup and self-manage from the CLI:

```sh
shoots setup     # download & verify external tools (exiftool) into ~/.shoots
shoots doctor    # environment health check
shoots update    # update the binary to the latest release
```

Prefer building from source? See [Setup](#setup).

## Non-goals

No RAW editing engine, no demosaicing, no GUI, no cloud backend (yet — the seams are there).

## Monorepo layout

```
packages/
  cli/        Thin layer: Commander commands + Ink progress UI. The only package that knows about terminals.
  core/       Pipeline engine, filename templating, file discovery, job queue, YAML pipeline config. Pure TS, zero UI deps.
  imaging/    exiftool wrapper (metadata, RAW embedded-preview extraction), sharp thumbnails, Laplacian blur detection.
  inference/  QualityModel interface + deterministic LocalStubModel. Future home of the onnxruntime-node backend.
```

Dependency direction: `cli → core/imaging/inference`, `imaging → core`. `core`, `imaging`, and `inference` never depend on `cli` or Ink — they are usable headlessly or from a future REST layer as-is.

## Prerequisites

- **Node.js ≥ 18.17** (developed on Node 26)
- **exiftool** — provisioned automatically into `~/.shoots` by `shoots setup` (or on first use of a command that needs it); no system install required. For development you can instead point `SHOOTS_EXIFTOOL=/path/to/exiftool` at an existing binary. Without any of these, `import` still works (original names, dates from file mtime) but `{camera}`/`{lens}`, `exif`, RAW culling, and `--write-xmp` are unavailable. On macOS/Linux exiftool runs via the system Perl.
- `sharp` installs prebuilt libvips binaries automatically via npm.

## Setup

```sh
npm install
npm run build          # builds core → imaging → inference → cli
```

Run the CLI in dev:

```sh
node packages/cli/dist/cli.js --help
# or the root convenience script:
npm run shoots -- --help
# or link it globally:
npm link -w @shoots/cli && shoots --help
```

For iterative development, `npm run dev -w @shoots/core` (etc.) runs `tsup --watch` per package.

## Interactive shell

Running `shoots` with no arguments on a terminal opens a fullscreen interactive shell (Claude Code-style):

```
  ███████╗██╗  ██╗ ██████╗  ██████╗ ████████╗███████╗
  ██╔════╝██║  ██║██╔═══██╗██╔═══██╗╚══██╔══╝██╔════╝
  ███████╗███████║██║   ██║██║   ██║   ██║   ███████╗
  ╚════██║██╔══██║██║   ██║██║   ██║   ██║   ╚════██║
  ███████║██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████║
  ╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝
  ◉ v0.1.0 — batch automation for photographers

❯ /cull @raw/ --threshold 120 --separate
```

- Runs in the terminal's **alternate screen buffer** (like vim): it takes over a clean screen, and on exit your previous terminal content is restored exactly as it was
- The **input is pinned to the bottom**; command output scrolls in the shell's own history above it
- **`/`** opens the command palette with autocomplete (`/import`, `/cull`, …) — `↑`/`↓` to navigate, `Tab` to accept
- **`@`** mentions files/folders with filesystem autocomplete (`@raw/`, `@"my folder/"`), capped at 6 entries with a `+N more` hint; mentions expand to plain paths before execution
- **`↑`/`↓`** also recall command history; **`Esc`** clears the input or cancels a running command
- Builtins: `/cd`, `/pwd`, `/clear`, `/help`, `/version`, `/exit`
- Commands run in a child process with live output streaming — identical behavior to batch mode

The shell only activates on a TTY; `shoots` in a pipe/cron prints help and all batch commands work unchanged, so scripts are unaffected.

## Commands

### `shoots import <source> --dest <path>`

Offload a card into a destination folder — renamed from EXIF, checksum-verified.

```sh
shoots import E:/DCIM/100CANON --dest D:/Shoots/2026/smith-wedding/raw \
  --pattern "{date}_{time}_{camera}_{seq:4}.{ext}" --dry-run
```

- Copy by default; `--move` deletes each source **only after** its copy's SHA-256 matches.
- A checksum mismatch fails loudly and removes the corrupt copy (never the source).
- Name collisions get `_2`, `_3`, … suffixes; existing files are never overwritten.

**Template tokens:** `{date}` `{time}` `{year}` `{month}` `{day}` `{camera}` `{lens}` `{orig}` `{seq}` (pad with `{seq:4}` → `0001`) `{ext}`. Sequence numbers follow capture-date order.

### `shoots rename <path> --pattern <template>`

Same templating engine, applied in place to an already-imported folder. Two-phase rename makes in-set swaps safe. `--recursive` keeps each file in its own directory.

```sh
shoots rename D:/Shoots/2026/smith-wedding/raw --pattern "{date}_{seq:4}_{orig}.{ext}" --dry-run
```

### `shoots exif <path>`

Batch read/write metadata via exiftool.

```sh
shoots exif ./raw --json                              # read → JSON report
shoots exif ./raw --set-artist "Jane Doe Photography" \
  --set-copyright "© 2026 Jane Doe" --set-keywords wedding,smith
shoots exif ./raw --config studio-tags.yaml           # tags from a YAML/JSON file
shoots exif ./raw --set "XMP:City=Rome"               # arbitrary exiftool tags
```

Writes keep exiftool's `*_original` backups unless you pass `--overwrite-original`.

### `shoots cull <path>`

Classic (non-ML) Laplacian-variance blur detection. RAW files are scored from their embedded JPEG preview — no demosaicing.

```sh
shoots cull ./raw --threshold 100 --format csv --out report.csv
shoots cull ./raw --separate --dest ./culled          # copies into culled/sharp + culled/blurry
```

Strictly non-destructive: originals are never moved or deleted — `--separate` copies.

### `shoots rate <path>`

Scores focus/aesthetics and suggests keywords through the `@shoots/inference` `QualityModel` interface, mapping to a 1–5 star rating.

```sh
shoots rate ./raw                    # writes <file>.shoots.json sidecars
shoots rate ./raw --write-xmp        # writes <file>.xmp sidecars (Rating + Subject) via exiftool
```

Currently backed by `LocalStubModel` — **deterministic placeholder scores** (hash-derived, stable across runs). Swapping in a real onnxruntime-node model is a change inside `@shoots/inference` only: implement `QualityModel`, register it in `createQualityModel()`.

## Pipelines (scaffolded, next stage)

`examples/wedding-pipeline.yaml` shows a full pipeline: import → exif tagging → blur cull → rating → (future) export. The config types (`PipelineConfig`) and the handler-based `PipelineRunner` live in `@shoots/core`; the `shoots run <config.yaml>` command that registers command logic as pipeline step handlers lands in a later stage.

## Scripting patterns

```sh
# JSON everywhere, logs on stderr → pipe-safe
shoots cull ./raw --json | jq '.results[] | select(.verdict == "blurry") | .file'

# exit codes make CI gates trivial
shoots import E:/DCIM --dest ./raw --json || notify-failure

# cron-friendly: no TTY → no interactive UI, plain logs only
0 2 * * * shoots cull /mnt/incoming --separate --json >> /var/log/shoots.log
```

## Development notes

- `npm run build` — builds all packages in dependency order (tsup/esbuild, ESM, Node ≥ 18).
- `npm run typecheck` — `tsc --noEmit` per package (build first so cross-package `.d.ts` files exist).
- Output conventions: stdout carries the command result (human or `--json`); all logs, warnings, and progress go to stderr.
