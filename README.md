<img src="assets/shoots.png" alt="" width="88" align="right"/>

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

## Documentation

Full documentation lives in [`docs/`](./docs/README.md):

- [Getting started](./docs/getting-started.md) — install, setup, first import
- [Core concepts](./docs/concepts.md) — non-destructive rules, exit codes, JSON output
- [Command reference](./docs/commands/README.md) — every command, every flag, with examples
- [Interactive shell](./docs/shell.md) · [Filename templates](./docs/templates.md) · [Rating profiles](./docs/profiles.md)
- [Preference learning](./docs/preference-learning.md) — train a rating profile on your own eye
- [Develop predictor](./docs/develop-predictor.md) — the local "Lightroom AI"
- [Scripting](./docs/scripting.md) · [Recipes](./docs/recipes.md) · [Troubleshooting](./docs/troubleshooting.md)
- [Configuration](./docs/configuration.md) · [Development](./docs/development.md)

## Non-goals

No RAW editing engine, no demosaicing, no GUI, no cloud backend (yet — the seams are there).

## Monorepo layout

```
packages/
  cli/        Thin layer: Commander commands + Ink progress UI. The only package that knows about terminals.
  core/       Pipeline engine, filename templating, file discovery, job queue, YAML pipeline config. Pure TS, zero UI deps.
  imaging/    exiftool wrapper (metadata, RAW embedded-preview extraction), sharp thumbnails, Laplacian blur detection.
  inference/  QualityModel interface + the onnxruntime-node CLIP backend: aesthetics, keywords, rating profiles.
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
shoots cull ./raw --threshold 100 --format csv --out report.csv    # report only, nothing moved
shoots cull ./catalog --dest ./rejects                             # move blurry rejects out, mirroring structure
shoots cull ./catalog --dest ./rejects --copy                      # copy them instead (leave originals)
shoots cull ./raw --focus-threshold 250                            # tune the shallow-DoF rescue (default 250)
shoots cull ./raw --no-focus-rescue                                # classify purely on the global score
```

**Focus-aware.** A single global sharpness score misjudges wide-aperture work: a shallow-depth-of-field portrait is mostly bokeh, so the global score is low even though the subject is tack-sharp. Alongside the global score, `cull` builds a focus map over a tile grid and takes a robust peak — the sharpness of the sharpest region. A frame whose global score is below `--threshold` is still kept as **sharp** (marked `sharp*`, `rescued: true`) when that peak clears `--focus-threshold`, since a motion-blurred or missed-focus frame is soft *everywhere*. The rescue only ever moves a frame from blurry → sharp; disable it with `--no-focus-rescue`.

**Keepers stay put; rejects go to `--dest`.** With no `--dest`, `cull` only reports. Give `--dest <dir>` and the blurry rejects are relocated there **mirroring the source folder structure** — `<catalog>/2026-07-19/x.cr3` → `<dest>/2026-07-19/x.cr3` — so a catalog/date layout survives into the rejects pile instead of being flattened. Sharp keepers (including `sharp*` rescues) are never touched. Rejects **move** by default (the source catalog ends up clean); pass `--copy` to leave the originals in place. Nothing is ever deleted.

**Interactive review (`--review`, shell only).** The same command gains a human-in-the-loop mode inside the interactive shell: `/cull <path> --review --dest <dir>` runs the focus-aware analysis but doesn't make you wait — it relocates the confident rejects immediately (leaving keepers in place), then hands you *only* the uncertain shallow-DoF rescues one at a time. Each review card shows the scores, aperture, and a focus heatmap with a legend (soft → sharp) marking where focus landed; `K` keeps (stays put), `D` discards (relocates to `--dest`), `P` opens the frame in your system viewer, `S` skips, `Esc` finishes. `--dest` is required (that's where discards go); add `--copy` to copy instead of move, or `--dry-run` to walk the whole flow without touching a file. `--review` needs the interactive shell (it drives a live UI); every other flag works the same in batch, so `shoots cull` stays fully scriptable.

### `shoots rate <path>`

Scores focus/aesthetics and suggests keywords via a local ONNX CLIP model, mapping to a strict 0–5 star rating shaped by a [rating profile](./docs/profiles.md).

```sh
shoots rate ./raw                              # writes <file>.shoots.json sidecars
shoots rate ./raw --write-xmp                  # writes <file>.xmp sidecars (Rating + Subject)
shoots rate ./raw --profile wedding            # street | generic | portrait | wildlife | wedding
shoots rate ./raw --profile my-eye             # a learned profile from ~/.shoots/profiles
```

Everything runs locally; nothing is uploaded. Only `street` is calibrated against a real hand-judged shoot — the rest are priors. To make the ratings genuinely yours, train a profile via [preference learning](./docs/preference-learning.md).

### `shoots embeddings <path>`

Profile-neutral CLIP export for preference-learning tooling. See [the command page](./docs/commands/embeddings.md).

### `shoots develop <export|train|predict|diagnose>`

Personal develop-setting predictor — the local "Lightroom AI", limited to the global look. See [the guide](./docs/develop-predictor.md).

### `shoots setup` · `shoots doctor` · `shoots update`

Provision external tools and the model, check the environment, self-update the binary. See [the command reference](./docs/commands/README.md).

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

## License

**Source-available, not open source.** `shoots` is licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

You are free to read, use, modify, and share the source code — but **only for
noncommercial purposes**. Any commercial use of the software, in whole or in
part, is not permitted under this license.

Copyright © 2026 Stefano Pascazi. All commercial rights are reserved by the
copyright holder. For a commercial license, contact stefanopascazi@gmail.com.
