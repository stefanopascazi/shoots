# `shoots cull`

Focus-aware blur detection over a folder of RAW/JPEG/PNG/TIFF files. Reports
sharpness, and optionally relocates the out-of-focus rejects out of your catalog.

```
shoots cull <path> [options]
```

This is **classic computer vision**, not ML: Laplacian variance plus a tile-based
focus map. It is fast, deterministic and needs no model.

---

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<path>` | yes | Folder (recursive) or a single file to analyze |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--threshold <n>` | `100` | Global Laplacian variance below this = blurry |
| `--focus-threshold <n>` | `250` | Keep a globally-soft frame if its sharpest region scores above this |
| `--no-focus-rescue` | rescue on | Disable the shallow-DoF rescue; classify purely on the global score |
| `--mark` | off | Record the verdict as a triage mark instead of moving anything |
| `--mark-label <name>` | `reject` | Semantic label for rejects: `reject`/`select`/`review`/`second-pass` |
| `--mark-keepers <name>` | — | Also label the keepers |
| `--dest <dir>` | — | Relocate blurry rejects here, mirroring the source structure |
| `--copy` | move | Copy rejects to `--dest` instead of moving them |
| `--format <fmt>` | `json` | Report format: `json` or `csv` |
| `--out <file>` | stdout | Write the report to a file |
| `--concurrency <n>` | `4` | Max parallel analyses |
| `--dry-run` | off | Analyze and report, but relocate nothing and write no report file |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |
| `--review` | off | Interactive human-in-the-loop review — **shell only** |

---

## How the scoring works

### The global score

Each frame is reduced to a single **Laplacian variance** — a standard measure of
edge energy. Lots of crisp edges → high variance → sharp. Motion blur or missed
focus smears edges → low variance → blurry.

RAW files are scored from their **embedded JPEG preview** (extracted with
exiftool), so no demosaicing is involved. The JSON reports which pixels were used
as `pixelSource`.

### Why a global score alone is wrong

A single global number misjudges wide-aperture work. A shallow-depth-of-field
portrait at f/1.4 is *mostly bokeh* — the global variance is low even though the
eyes are tack-sharp. Cull naively and you throw away your best frames.

### The focus rescue

Alongside the global score, `cull` builds a **focus map** over a tile grid and
takes a robust peak: the sharpness of the sharpest region in the frame.

> A frame whose global score is below `--threshold` is still kept as **sharp**
> (marked `sharp*`, `rescued: true`) when that focus peak clears
> `--focus-threshold`.

The reasoning is simple: a motion-blurred or missed-focus frame is soft
*everywhere*. If any region is genuinely sharp, focus landed somewhere on purpose.

The rescue only ever moves a frame **blurry → sharp**, never the reverse. Disable
it with `--no-focus-rescue`.

### Aperture context

When exiftool is available, the report carries each frame's `FNumber`. A low
global score at f/11 means something very different than at f/1.4. This is
**report context only** — it never influences the verdict. If exiftool is
unavailable the column is simply omitted rather than failing the cull.

---

## What moves where

| You pass | What happens |
| --- | --- |
| *(nothing)* | **Report only.** Nothing is moved or copied. |
| `--mark` | The verdict is **recorded**, not acted on. No file moves. |
| `--dest <dir>` | Blurry rejects are **moved** into `<dir>`; keepers stay put. |
| `--dest <dir> --copy` | Rejects are **copied**; originals stay in place too. |

Keepers — including `sharp*` rescues — are **never** touched. Nothing is ever
deleted.

### Marking instead of moving

Relocating rejects reorganizes your catalog to record a decision. `--mark` records
the decision and leaves the catalog alone:

```sh
shoots cull ./shoot --mark --mark-keepers select
```

```
482 analyzed @ threshold 100: 431 sharp (18 rescued), 51 blurry, 0 failed
marked 482 files (rejects 'reject', keepers 'select') — `shoots develop edit` or `shoots triage apply` writes them into sidecars
```

Nothing is written next to the photographs. The verdict waits under
`~/.shoots/triage` until a sidecar writer picks it up and renders it as a colour
label in your editor's own vocabulary — see [`triage`](./triage.md).

This is what composes: `rate --mark` afterwards adds stars to the same records
instead of fighting over the same sidecar, and `develop edit` writes all of it
out at once.

The two are not exclusive. `--mark --dest <dir>` both records the verdict and
moves the rejects; the marks follow the files to their new location.

### Structure is mirrored, not flattened

```
<catalog>/2026-07-19/x.cr3   →   <dest>/2026-07-19/x.cr3
<catalog>/2026-07-20/y.cr3   →   <dest>/2026-07-20/y.cr3
```

A catalog/date layout survives into the rejects pile, so you can inspect (or
restore) rejects with their context intact.

### `--dest` is excluded from the scan

If `--dest` sits inside the target folder, it is filtered out of the scan — a
second run will not re-analyze already-relocated rejects.

---

## Tuning the thresholds

Thresholds are **camera-, lens- and subject-dependent**. There is no universal
value. The workflow is: report first, look at the numbers, then set a threshold.

```sh
# 1. Report only, as CSV, so you can look at the distribution
shoots cull ./raw --format csv --out scores.csv

# 2. Inspect
sort -t, -k2 -n scores.csv | head -30     # the softest frames

# 3. Pick a threshold that puts the boundary where you'd put it, then apply
shoots cull ./raw --threshold 85 --dest ./rejects --dry-run
```

Rough starting points:

| Situation | `--threshold` | `--focus-threshold` |
| --- | --- | --- |
| Default | `100` | `250` |
| High-res bodies (45MP+), lots of detail | `120–180` | `300+` |
| Shallow DoF portrait / wide-open work | `60–100` | `200–250` |
| Low-light, high-ISO (noise inflates variance) | higher | higher |
| Deep-DoF landscape (rescue rarely needed) | `100–150` | `--no-focus-rescue` |

---

## Examples

### Report only

```sh
shoots cull ./raw
```

```
verdict       score       focus    aper  file
sharp        412.83      891.20    f/2.8  D:/raw/IMG_0001.CR3
sharp*        78.14      623.55    f/1.4  D:/raw/IMG_0002.CR3
blurry        31.02       44.18    f/2.8  D:/raw/IMG_0003.CR3

482 analyzed @ threshold 100: 431 sharp (18 rescued), 51 blurry, 0 failed
  sharp* = subject in focus despite a soft frame (shallow DoF), kept via --focus-threshold 250
```

### CSV report to a file

```sh
shoots cull ./raw --format csv --out cull-report.csv
```

```csv
file,score,focus_peak,verdict,rescued,aperture,pixel_source
D:/raw/IMG_0001.CR3,412.83,891.2,sharp,false,2.8,embedded-preview
D:/raw/IMG_0002.CR3,78.14,623.55,sharp,true,1.4,embedded-preview
D:/raw/IMG_0003.CR3,31.02,44.18,blurry,false,2.8,embedded-preview
```

### Mark instead of moving (composes with `rate` and `develop`)

```sh
shoots cull ./shoot --mark
shoots rate ./shoot --mark
shoots develop edit ./shoot        # writes crs + label + stars in one sidecar
```

### Clean the catalog: move rejects out

```sh
shoots cull ./catalog --dest ./rejects --dry-run
```

```
(dry run) 51 rejects would be moved into D:\rejects (mirroring structure); keepers stay put
```

```sh
shoots cull ./catalog --dest ./rejects
```

```
moved 51 rejects into D:\rejects (mirroring structure); keepers left in place
```

### Copy instead of move (keep the catalog complete)

```sh
shoots cull ./catalog --dest ./review-blurry --copy
```

### Tuned for wide-open portrait work

```sh
shoots cull ./portraits --threshold 70 --focus-threshold 220 --dest ./rejects
```

### Strict: no rescue, global score only

```sh
shoots cull ./raw --no-focus-rescue --threshold 150 --dest ./rejects
```

### Fast, on many cores

```sh
shoots cull ./raw --concurrency 12 --json --out cull.json
```

---

## Interactive review (`--review`)

Available **only inside the interactive shell** — it drives a live UI. In batch
mode it exits `2` with a pointer to the shell.

```
❯ /cull ./catalog --review --dest ./rejects
```

The flow is designed to not waste your time:

1. The focus-aware analysis runs over the whole folder.
2. **Confident rejects are relocated immediately.** Keepers stay in place.
3. You are handed *only* the uncertain shallow-DoF rescues — one card at a time.

Each review card shows the global score, the focus peak, the aperture, and a
**focus heatmap** with a legend (soft → sharp) marking where focus actually landed.

| Key | Action |
| --- | --- |
| `K` | Keep — the file stays where it is |
| `D` | Discard — relocate it to `--dest` |
| `P` | Preview — open the frame in your system image viewer |
| `S` | Skip — decide later |
| `Esc` | Finish the review |

Requirements and flags:

- `--dest` is **required** (that is where discards go).
- `--copy` copies discards instead of moving them.
- `--dry-run` walks the entire flow without touching a single file — ideal for
  learning the interface.

Every other flag behaves identically in batch, so `shoots cull` stays fully
scriptable. Only the review UI is interactive.

---

## JSON output

```json
{
  "command": "cull",
  "threshold": 100,
  "focusThreshold": 250,
  "focusRescue": true,
  "dryRun": false,
  "results": [
    {
      "file": "D:/raw/IMG_0002.CR3",
      "score": 78.14,
      "focusPeak": 623.55,
      "verdict": "sharp",
      "rescued": true,
      "aperture": 1.4,
      "pixelSource": "embedded-preview"
    }
  ],
  "errors": [],
  "relocated": {
    "dest": "D:\\rejects",
    "mode": "move",
    "count": 51,
    "planned": false
  },
  "summary": { "total": 482, "sharp": 431, "blurry": 51, "rescued": 18, "failed": 0 }
}
```

| Field | Meaning |
| --- | --- |
| `score` | Global Laplacian variance |
| `focusPeak` | Robust peak of the tile focus map — the sharpest region |
| `verdict` | `"sharp"` or `"blurry"` (post-rescue) |
| `rescued` | `true` when the focus rescue flipped it to sharp (`sharp*` in the table) |
| `aperture` | EXIF `FNumber`, or `null` when unavailable |
| `pixelSource` | Which pixels were scored — e.g. `embedded-preview` for RAW |
| `relocated` | Present only with `--dest`. `planned: true` under `--dry-run`. |
| `marked` | Present only with `--mark`: the labels used and how many records were written. |

### Useful queries

```sh
# List the rejects
shoots cull ./raw --json | jq -r '.results[] | select(.verdict=="blurry") | .file'

# List only the rescues — the frames worth eyeballing
shoots cull ./raw --json | jq -r '.results[] | select(.rescued) | "\(.score)\t\(.focusPeak)\t\(.file)"'

# Reject rate as a CI gate
rate=$(shoots cull ./raw --json | jq '.summary.blurry / .summary.total')
```

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | Analysis completed with no per-file failures |
| `1` | At least one file failed to analyze or relocate |
| `2` | Invalid `--threshold` / `--focus-threshold` / `--format`, `--out` points at a directory, or `--review` used outside the shell |

---

## See also

- [`triage`](./triage.md) — where `--mark` puts the verdict, and how it gets out
- [`rate`](./rate.md) — aesthetic and star ratings (ML), complementary to blur culling
- [Interactive shell](../shell.md) — where `--review` lives
- [Recipes](../recipes.md) — culling inside a full workflow
