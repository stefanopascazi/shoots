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

### Machine learning

| Command | Purpose |
| --- | --- |
| [`embeddings`](./embeddings.md) | Export profile-neutral CLIP embeddings for preference-learning tools |
| [`develop`](./develop.md) | Personal develop-setting predictor: `export` → `train` → `predict` → `feedback`, plus `refresh-targets` and `diagnose` |

### Maintenance

| Command | Purpose |
| --- | --- |
| [`setup`](./setup.md) | Download & verify exiftool, LibRaw and the inference model into `~/.shoots` |
| [`doctor`](./doctor.md) | Environment health check |
| [`update`](./update.md) | Self-update the standalone binary |
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
                   [--dest <dir>] [--copy] [--format json|csv] [--out <file>]
                   [--concurrency 4] [--dry-run] [--json] [--review]

shoots rate <path> [--model onnx] [--profile <name>] [--write-xmp]
                   [--concurrency 4] [--dry-run] [--json]

# ── ML tooling ────────────────────────────────────────────────────────────────
shoots embeddings <path> [--out <dir>] [--previews auto|always|never]
                         [--preview-size 1024] [--preview-quality 82]
                         [--concurrency 4] [--json]

shoots develop init <path> [--out-export <f>] [--out-train <f>] [--name <n>] [--dry-run]
shoots develop edit <path> [--profile <f>] [--treatment auto|color|bw] [--force] [--dry-run]
shoots develop status [--json]
shoots develop clean  [--all] [--dry-run] [--json]
shoots develop export <path> --out <file> [--baseline embedded-preview|external]
                                          [--edited-only] [--concurrency 4] [--json]
shoots develop refresh-targets --data <f> --out <f> [--drop-unedited] [--json]
shoots develop train  --data <f> --name <n> --out <f> [--lambda auto|<n>] [--folds 5]
shoots develop predict --data <f> --profile <f> [--treatment auto|color|bw]
                                                [--camera-profile <name>]
                                                [--out <f>] [--xmp <dir>]
shoots develop feedback --predictions <f> [--out <f>] [--json]
shoots develop diagnose --data <f> [--folds 5] [--max-k 4]

# ── Maintenance ───────────────────────────────────────────────────────────────
shoots setup  [--json]
shoots doctor [--json]
shoots update [--check] [--json]
```

---

## Flag conventions

| Pattern | Meaning |
| --- | --- |
| `--no-<flag>` | Turns off a default-on behaviour: `--no-focus-rescue`, `--no-recursive` |
| `--set <Tag=Value>` | Repeatable — pass it multiple times to set multiple tags |
| `--dest` | Where output goes. Its meaning is per-command: destination catalog for `import`, **rejects** folder for `cull` |
| `--out` | A single output **file** (a report, a dataset, a profile) — except `embeddings --out`, which is a bundle **directory** |
