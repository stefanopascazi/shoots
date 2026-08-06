# Command reference

```
shoots [command] [arguments] [options]
```

Running `shoots` with no arguments on a terminal opens the
[interactive shell](../shell.md). In a pipe or a cron job it prints help instead,
so scripts are unaffected.

---

## Commands

### Workflow

| Command | Purpose |
| --- | --- |
| [`import`](./import.md) | Copy/move photos from a card into a catalog, renamed and checksum-verified |
| [`rename`](./rename.md) | Batch-rename an already-imported folder in place |
| [`exif`](./exif.md) | Batch read/write EXIF·IPTC·XMP metadata |
| [`cull`](./cull.md) | Focus-aware blur detection; report, relocate rejects, or review interactively |
| [`rate`](./rate.md) | 0–5 star ratings + keyword suggestions via the ONNX CLIP model |
| [`triage`](./triage.md) | The marks `cull`/`rate` record before they reach a sidecar: `list`, `apply`, `clean` |

### Machine learning

| Command | Purpose |
| --- | --- |
| [`embeddings`](./embeddings.md) | Export profile-neutral CLIP embeddings for preference-learning tools |
| [`match`](./match.md) | Learn your eye from pairwise duels: `import` → `serve` → `train` a rating profile |
| [`develop`](./develop.md) | Personal develop-setting predictor: `init` → `edit` → `refine`, plus the steps underneath (`export`, `train`, `predict`, `feedback`, `learn`, `calibrate`, `diagnose`) |

### Orchestration

| Command | Purpose |
| --- | --- |
| [`pipeline`](./pipeline.md) | Run a [YAML pipeline](../pipelines.md): shoots commands in order, sharing variables |
| [`schedule`](./schedule.md) | Run `develop refine` daily and unattended, via cron / the Windows Task Scheduler |

### Maintenance

| Command | Purpose |
| --- | --- |
| [`setup`](./setup.md) | Download & verify exiftool, LibRaw and the inference model into `~/.shoots` |
| [`doctor`](./doctor.md) | Environment health check |
| [`update`](./update.md) | Self-update the standalone binary |
| [`release-notes`](./release-notes.md) | The migration steps this release needs, checked against `~/.shoots` |
| `shell` | Open the interactive shell explicitly |

---

## Global options

These are accepted by (nearly) every command. Command pages list the exceptions.

| Option | Meaning |
| --- | --- |
| `--json` | Emit a machine-readable JSON document on stdout, suppressing human output |
| `--verbose` | Verbose diagnostics on stderr (never on stdout) |
| `--dry-run` | Plan and report without touching the filesystem *(mutating commands only)* |
| `--concurrency <n>` | Max parallel operations, default `4` *(per-file commands only)* |
| `--help` | Command help |
| `--version` | Print the `shoots` version (top level only) |

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | One or more per-file operations failed |
| `2` | Bad usage — invalid flag, unknown profile, missing prerequisite |

---

## Cheat sheet

```sh
# ── Ingest ────────────────────────────────────────────────────────────────────
shoots import <src> --dest <dir> [--rename|--pattern <tpl>] [--dir <tpl>|--flat]
                                 [--move] [--concurrency 4] [--dry-run] [--json]

shoots rename <path> --pattern <tpl> [--recursive] [--dry-run] [--json]

# ── Metadata ──────────────────────────────────────────────────────────────────
shoots exif <path> [--tags <list>]                                    # read
shoots exif <path> [--set-artist <t>] [--set-copyright <t>]
                   [--set-keywords a,b] [--set Tag=Value ...]
                   [--config <file>] [--overwrite-original]
                   [--no-recursive] [--dry-run] [--json]              # write

# ── Selection ─────────────────────────────────────────────────────────────────
shoots cull <path> [--threshold 100] [--focus-threshold 250] [--no-focus-rescue]
                   [--mark] [--mark-label reject] [--mark-keepers select]
                   [--dest <dir>] [--copy] [--format json|csv] [--out <file>]
                   [--concurrency 4] [--dry-run] [--json] [--review]

shoots rate <path> [--model onnx] [--profile <name>] [--mark] [--write-xmp]
                   [--concurrency 4] [--dry-run] [--json]

shoots triage list  [<path>] [--json]
shoots triage apply <path> [--editor acr|rapidraw] [--redo] [--dry-run] [--json]
shoots triage clean [--orphans] [--dry-run] [--json]

# ── ML tooling ────────────────────────────────────────────────────────────────
shoots embeddings <path> [--out <dir>] [--previews auto|always|never]
                         [--preview-size 1024] [--preview-quality 82]
                         [--concurrency 4] [--json]

shoots match import --data <f> [--name my-eye] [--images <dir>] [--db <f>] [--json]
shoots match serve  [--name my-eye] [--db <f>] [--port 4576] [--host 127.0.0.1]
shoots match train  [--name my-eye] [--out <f>] [--db <f>] [--lambda 1]
                                    [--holdout 0.2] [--json]

shoots develop init <path> [--out-export <f>] [--out-train <f>] [--name <n>]
                           [--baseline external|embedded-preview] [--boldness 0]
                           [--anchor-gain 1] [--review] [--dry-run]
shoots develop edit <path> [--profile <f>] [--treatment auto|color|bw] [--force]
                           [--no-apply-marks] [--dry-run]
shoots develop status [--json]
shoots develop clean  [--all] [--dry-run] [--json]
shoots develop export <path> --out <file> [--baseline embedded-preview|external]
                                          [--edited-only] [--concurrency 4] [--json]
shoots develop refresh-targets --data <f> --out <f> [--drop-unedited] [--json]
shoots develop train  --data <f> --name <n> --out <f> [--lambda auto|<n>] [--folds 5]
                      [--boldness 0] [--anchor-gain 1] [--review] [--all]
shoots develop predict --data <f> --profile <f> [--treatment auto|color|bw]
                                                [--camera-profile <name>]
                                                [--out <f>] [--sidecars <dir>]
shoots develop feedback --predictions <f> [--out <f>] [--journal <f>|--no-journal]
                                          [--min-moved <n>] [--json]
shoots develop refine <shoot> [--measure-only] [--dry-run] [--json]
shoots develop calibrate [--profile <f>] [--journal <f>] [--shrink 0.5]
                         [--min-shoots 4] [--imported-only] [--include-in-sample]
                         [--review] [--reset] [--dry-run]
shoots develop learn <shoot> [--data <f>] [--out <f>] [--min-weight 0.25]
                             [--max-weight 3] [--no-train] [--dry-run] [--json]
shoots develop diagnose --data <f> [--folds 5] [--max-k 4]

# ── Unattended ────────────────────────────────────────────────────────────────
shoots schedule install [--at 03:00] [--dry-run] [--json]
shoots schedule status  [--json]
shoots schedule uninstall [--json]
shoots schedule run [--force] [--editor <id>] [--home <dir>] [--dry-run] [--json]

# ── Maintenance ───────────────────────────────────────────────────────────────
shoots setup  [--json]
shoots doctor [--json]
shoots update [--check] [--json]
shoots release-notes [--all] [--json]
```

---

## Flag conventions

| Pattern | Meaning |
| --- | --- |
| `--no-<flag>` | Turns off a default-on behaviour: `--no-focus-rescue`, `--no-recursive` |
| `--set <Tag=Value>` | Repeatable — pass it multiple times to set multiple tags |
| `--dest` | Where output goes. Its meaning is per-command: destination catalog for `import`, **rejects** folder for `cull` |
| `--out` | A single output **file** (a report, a dataset, a profile) — except `embeddings --out`, which is a bundle **directory** |
