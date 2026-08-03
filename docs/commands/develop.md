# `shoots develop`

Personal **develop-setting predictor** — the local "Lightroom AI", limited to the
*global look*. It learns your develop style from your own catalog and predicts a
per-image starting point for a new shoot.

```
shoots develop <subcommand> [options]
```

**Everyday pair** — these wrap the steps below with conventional paths under
`~/.shoots/develop`, so nothing has to be remembered between sessions:

| Subcommand | Purpose |
| --- | --- |
| [`init`](#shoots-develop-init) | Learn your style from an edited catalog (`export` + `train`) |
| [`edit`](#shoots-develop-edit) | Develop a shoot with it (`export` + `predict`) |
| [`feedback`](#shoots-develop-feedback) | How much of that prediction you kept |
| [`refine`](#shoots-develop-refine) | Close the loop on a developed shoot: `feedback` + `learn` + `calibrate` |
| [`calibrate`](#shoots-develop-calibrate) | Fix what it is wrong by on average (a constant offset) |
| [`learn`](#shoots-develop-learn) | Refit on a shoot you developed, weighted by how much you changed |
| [`status`](#shoots-develop-status) | What this machine holds |
| [`clean`](#shoots-develop-clean) | Drop the per-shoot working files |

**The individual steps**, still there whenever the convention is not what you want:

| Subcommand | Purpose |
| --- | --- |
| [`export`](#shoots-develop-export) | Build a training dataset from an edited catalog |
| [`refresh-targets`](#shoots-develop-refresh-targets) | Re-read an existing dataset's targets without recomputing pixels |
| [`train`](#shoots-develop-train) | Fit a per-catalog develop profile |
| [`predict`](#shoots-develop-predict) | Apply a profile → predicted develop vector / XMP sidecar |
| [`diagnose`](#shoots-develop-diagnose) | Style-clustering diagnostic |

`export` is the only step that touches ONNX / exiftool for pixels;
`refresh-targets` needs exiftool but no image decoding. `train`, `predict` and
`diagnose` are pure maths over the exported dataset.

For the conceptual background — what is predicted, why deltas, how to read the
go/no-go metric — see the [Develop predictor guide](../develop-predictor.md).

---

## The everyday pipeline

```sh
# once, from a catalog you have already developed
shoots develop init ~/Catalogs/2025

# per shoot — sidecars land next to the photographs
shoots develop edit ~/Shoots/2026-07-19

# after developing them in Lightroom — the whole loop, in order
shoots develop refine ~/Shoots/2026-07-19

# when the working files pile up
shoots develop clean
```

Everything lives under `~/.shoots/develop` (override the root with `SHOOTS_HOME`):

```
develop/
  export/export.jsonl              the training dataset      ← init
  profile/export.json              the fitted style profile  ← init, calibrate
  feedback.jsonl                   every correction, ever    ← feedback → calibrate
  export/shooting/<folder>/        one directory per shoot   ← edit
    export.jsonl                     what the shoot looks like
    prediction.json                  what we proposed        → feedback
```

`feedback.jsonl` is the one file here that cannot be rebuilt — `clean` never
touches it, `--all` or not.

Every one of these accepts `--dry-run`.

---

## `shoots develop init`

`export --edited-only` + `train`, into the conventional paths.

```
shoots develop init <path> [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--out-export <file>` | `~/.shoots/develop/export/export.jsonl` | Training dataset path |
| `--out-train <file>` | `~/.shoots/develop/profile/export.json` | Profile path |
| `--name <name>` | `my-style` | Profile name |
| `--baseline <mode>` | `external` | Baseline render (note: **not** the `export` default) |
| `--everything` | off | Export every file, not only those carrying an edit |
| `--dry-run` | off | Print the steps and the paths, write nothing |

It also takes every `train` flag — `--lambda`, `--folds`, `--group-by`,
`--gate-threshold`, `--embedding-dim`, `--all` — plus `--model`,
`--concurrency` and `--editor`. If the export fails it stops rather than
training on a half-written dataset.

---

## `shoots develop edit`

`export` + `predict` over one shoot. The sidecars are written **next to the
photographs**, which is where Lightroom looks for them.

```
shoots develop edit <path> [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--profile <file>` | the one `init` wrote | Profile to apply |
| `--treatment <t>` | `auto` | `auto` \| `color` \| `bw` |
| `--camera-profile <name>` | catalog's own | Base rendering to assume and write out |
| `--baseline <mode>` | `external` | Must match the profile's, or `predict` refuses |
| `--force` | off | Overwrite sidecars that already carry a real edit |
| `--no-apply-marks` | apply on | Leave pending `cull`/`rate` marks in the store instead of writing them out |
| `--dry-run` | off | Print the steps and the paths, write nothing |

> **It refuses to overwrite your work.** Writing into the photo folder means an
> existing edit would be replaced, so it counts the sidecars that carry one and
> stops. `--force` proceeds; `--dry-run` shows the plan first.

### It is the last stop for triage marks

`edit` is the end of `cull` → `rate` → `develop`, so it is where the marks those
commands recorded become part of the sidecar it writes:

```sh
shoots cull ./shoot --mark
shoots rate ./shoot --mark
shoots develop edit ./shoot
```

One sidecar per photograph, carrying the `crs:` prediction, the colour label and
the star rating. `--dry-run` counts what is pending; `--no-apply-marks` leaves
them for [`shoots triage apply`](./triage.md). Applied marks are kept (not
deleted) so a discarded sidecar can be rebuilt — `shoots triage clean` purges them.

### What survives a rewrite

Emitting `crs:` means templating the whole sidecar, so `edit` reads what is
already there and merges it back afterwards: **`xmp:Label`, `xmp:Rating`,
`dc:subject`, titles, captions and authorship are preserved.** Only the develop
settings are replaced — which is what the `--force` guard is about.

---

## `shoots develop status`

What is on this machine: the dataset, the profile (name, age, skill, how many
parameters are gated) and the cached shoots.

```
shoots develop status [--json]
```

---

## `shoots develop clean`

Removes the per-shoot working directories. Both files in them are regenerable —
the dataset from the photographs, the record by predicting again.

```
shoots develop clean [--all] [--dry-run] [--json]
```

`--all` also removes the training dataset and the profile, which cost a full
export and a train to rebuild. The profile is **not** touched otherwise.

---

## `shoots develop export`

Extract CLIP embeddings, colour features and `crs` develop targets into a JSONL
dataset.

```
shoots develop export <path> --out <file> [options]
```

### Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<path>` | yes | Folder (recursive) or single file of RAW/edited images carrying develop settings |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--out <file>` | **required** | Write the JSONL dataset here |
| `--baseline <mode>` | `embedded-preview` | Baseline render strategy: `embedded-preview` \| `external` |
| `--edited-only` | off | Only run the expensive embedding/render on files that actually carry develop settings |
| `--model <kind>` | `onnx` | Inference backend |
| `--concurrency <n>` | `4` | Max parallel jobs |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

### `--edited-only`

Reads `crs` settings from the (cheap) sidecars **first**, and runs the expensive
embedding + render only on files that carry develop settings. On a mixed catalog
this is the difference between minutes and hours.

Unedited frames carry no target, but they do describe the *session*. Whether
that is worth exporting them is a measured question, and on the reference catalog
the answer is **no**: session descriptions built from all 2421 frames instead of
the 553 edited ones moved the weighted skill by 0.02pp. Keep using it — it is
four times faster here for no measurable loss.

Do *not* use it when exporting a new,
unedited shoot to predict on — there is nothing to filter on yet, and you would
export an empty dataset.

### `--baseline`

Photometric features must come from a render of the image **before** the edit.
Two strategies, both editor-agnostic:

| Mode | What it renders | Trade-off |
| --- | --- | --- |
| `embedded-preview` *(default)* | The RAW's embedded JPEG preview | Zero setup, but an **approximation** — the preview bakes in the camera's picture style, polluting exposure/tone features. Expect absolute-luminance parameters (exposure/whites/blacks) to stay near your mean. |
| `external` | A neutral, camera-independent render via a stand-alone RAW developer | Accurate scene exposure. Zero-config: provisions LibRaw `dcraw_emu` into `~/.shoots` on first use. |

Override the external developer with your own:

```sh
export SHOOTS_RAW_DEVELOPER=dcraw_emu
# default args already target dcraw_emu: -w -W -o 1 -q 0 -T -Z {out} {in}

# …or RawTherapee-cli with a neutral profile
export SHOOTS_RAW_DEVELOPER=rawtherapee-cli
export SHOOTS_RAW_DEVELOPER_ARGS='-Y -q -o {out} -p neutral.pp3 -c {in}'
```

`{in}` / `{out}` are substituted per file; the render goes to a temp dir. Only RAW
files are re-rendered — rendered formats use their own pixels, and CLIP always
stays on the embedded preview (it is colour-invariant).

The chosen strategy is recorded in both the dataset and the resulting profile.

> **Target-leak note.** For proprietary RAW (CR3/NEF/ARW) the embedded preview is
> the camera JPEG — edit-independent, so no leak. DNG with *updated* previews can
> leak the edit into the features and should be checked.

### Examples

```sh
# Training set from an edited catalog
shoots develop export ~/Catalogs/2025-edited --edited-only --out train.jsonl

# Same, with the accurate neutral baseline
shoots develop export ~/Catalogs/2025-edited --edited-only \
  --baseline external --out train-neutral.jsonl --verbose

# A new, unedited shoot to predict on — no --edited-only
shoots develop export ~/Shoots/2026-07-new --out new.jsonl
```

```
Wrote develop dataset to train.jsonl: 3412 images, 2871 with develop settings (baseline: embedded-preview).
```

### Dataset format

JSONL — one record per line, plus a trailing `_type: "develop-meta"` line carrying
the model, dimensions, baseline and summary.

```jsonc
{
  "file": "…/IMG_0001.CR3",
  "embedding": [/* 512 floats */],
  "features": [/* colour/photometric features */],
  "develop": { "Exposure2012": 0.35, "Contrast2012": 12, "Temperature": 5400, "…": 0 },
  "asShot": {
    "tempAsShot": 5200, "tintAsShot": 8,
    "iso": 800, "exposureComp": -0.33, "camera": "Canon EOS R5"
  },
  "treatment": "color",
  "baseProfile": "Adobe Standard v2",
  "look": "Adobe Color",
  "curve": [0, 0, 32, 22, 128, 128, 255, 255]
}
```

| Field | Meaning |
| --- | --- |
| `develop` | The `crs` settings present on the file. Absent keys are neutral. |
| `asShot` | Camera reference state — the delta reference for white balance |
| `treatment` | `color` or `bw`, derived deterministically from the edit (GrayMixer ⇒ bw) |
| `baseProfile` | The `crs:CameraProfile` the edit sat on — the *base* only |
| `look` | The creative profile layered over it, e.g. `Adobe Color` (see below) |
| `curve` | Flattened point tone curve `[x0,y0,x1,y1,…]`; absent when linear/default |

The trailing meta line additionally carries `looks`: each distinct Look's own
serialization, stored once for the whole dataset rather than on every record.

---

## `shoots develop refresh-targets`

Re-read an existing dataset's supervised targets **without recomputing a single
pixel**.

```
shoots develop refresh-targets --data <file> --out <file> [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--data <file>` | **required** | Existing dataset from `develop export` |
| `--out <file>` | **required** | Write the refreshed JSONL dataset here |
| `--editor <id>` | `acr` | Which editor's develop settings to read |
| `--drop-unedited` | off | Drop records carrying no real edit instead of keeping them for session context |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

### Why it exists

The expensive half of `export` is the CLIP embedding and the neutral baseline
render. The targets are a cheap pass over the editor's sidecars. When the
**target side** changes, re-exporting recomputes hours of features that did not
change — on a 1045-image catalog, 7 minutes instead of hours.

Reach for it whenever the target side moves:

- a `crs` tag was read under the wrong name and is now fixed,
- the schema gained a parameter, or the base rendering gained the Look,
- the definition of "edited" got stricter.

It rebuilds `develop` / `asShot` / `baseProfile` / `look` / `curve` / `treatment`
and keeps `embedding` / `features` exactly as they were. The output is the
dataset a fresh export *would* have produced today, so records that no longer
qualify as edited are dropped — and counted, never silently.

Files it cannot read (moved, or the share is offline) are carried through
untouched and reported, rather than silently turning a real edit into an empty
one.

### Examples

```sh
# After a fix to the target side — then retrain on the refreshed dataset
shoots develop refresh-targets --data train.jsonl --out train-v2.jsonl
shoots develop train --data train-v2.jsonl --name my-style --out profiles/my-style.json
```

```
Refreshed 553/553 records → train-v2.jsonl
```

Records that no longer carry a real edit are reported on their own line
(`dropped N no longer carrying a real edit`), as are files that could not be read.

> `refresh-targets` never touches your catalog. It reads sidecars and writes one
> new dataset file.

---

## `shoots develop train`

Fit the per-catalog develop profile: a multi-output ridge regression over develop
*deltas*.

```
shoots develop train --data <file> --name <name> --out <file> [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--data <file>` | **required** | Dataset from `develop export` |
| `--name <name>` | **required** | Profile name |
| `--out <file>` | **required** | Output profile JSON path |
| `--lambda <n>` | `auto` | Ridge strength for every parameter, or `auto` to choose one **per parameter** by cross-validation |
| `--folds <k>` | `5` | Cross-validation folds |
| `--embedding-dim <k>` | `16` | CLIP components to keep; `0` drops the embedding, a high value keeps it raw |

One model is trained **per treatment** over `shared + <branch>`, so a
high-contrast B&W edit and a light colour edit never average into a mush.

### Each image is described alongside its whole shoot

Most of a develop decision is "this shoot", not "this frame" — on a real catalog
the session accounts for 26–67% of the variance of the targets. So every image
also carries the mean photometric description of its folder, which is the largest
single accuracy gain in this tool.

Two consequences worth knowing:

- **The description uses every record in the dataset**, edited or not. Exporting
  the unedited frames as well is therefore possible, but measured neutral on the
  reference catalog (0.02pp) — so `--edited-only` remains the sensible default.
- **Predict on a shoot, not on a file.** A frame's prediction depends on what
  else is in its folder. `predict` warns when images sit alone in theirs.

A branch with too few images cannot afford the extra columns and skips them; the
report says which did:

```
  session context: 44 features describing each image's whole shoot
  session context: off — too few images in this branch to afford it
```

### The CLIP embedding is compressed

512 dimensions against a few hundred photographs is p≫n, and carrying them raw
measured *worse* than dropping them. `--embedding-dim` (default 16) projects onto
that many principal components, refitted inside every fold. `0` drops the
embedding; a value at or above its dimension keeps it raw.

### Regularization is per parameter

Exposure and the HSL sliders do not want the same amount of shrinkage. Under a
single shared λ the choice is made by an average that the unpredictable majority
of parameters dominates — on a real catalog that pinned λ to the top of the grid
and collapsed *every* parameter onto the photographer's mean, which from the
outside looks like "it predicts the same settings for every photo".

`--lambda auto` therefore picks a λ per parameter, reported in the `λ` column of
the table and summarised in the branch header:

```
λ per param (auto): 30000×62 100×6
```

Everything piling onto the top of the grid means the model cannot read this
catalog — the same information the skill column carries, one line earlier.

The gate pays for that search: λ is re-chosen inside each held-out fold, so no
parameter is ever scored on the split that picked its own λ. Selecting on the
folds you then report would hand each of ~90 parameters the best of six tries,
and that alone is enough noise to push unpredictable sliders past the gate.

### Reading the output — the go/no-go GATE

`train` reports, per parameter, the held-out **MAE of the model** versus the
**"apply my average edit"** baseline, plus a skill score:

```
skill = 1 − modelMae / baselineMae
```

- `skill > 0` → the model beats simply applying your mean edit.
- The **headline number** is the weighted skill over the *image-dependent*
  parameters (exposure, WB, contrast, highlights/shadows, dehaze/vibrance).
- Style-constant parameters (HSL, colour grading) are **expected** to collapse to
  your mean. That is correct behaviour, not a failure.

If the headline skill is not clearly positive on a real catalog, the signal is too
weak — reconsider the baseline render strategy before building anything on it.

### Examples

```sh
shoots develop train --data train.jsonl --name my-style --out profiles/my-style.json

# Explicit regularization and more folds
shoots develop train --data train.jsonl --name my-style \
  --out profiles/my-style.json --lambda 2.5 --folds 10
```

---

## `shoots develop predict`

Apply a trained profile to a new develop-export dataset.

```
shoots develop predict --data <file> --profile <file> [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--data <file>` | **required** | Dataset from `develop export` (the **new** set) |
| `--profile <file>` | **required** | Profile JSON from `develop train` |
| `--treatment <t>` | `auto` | Which branch to apply: `auto` \| `color` \| `bw` |
| `--camera-profile <name>` | catalog's own | Base rendering to assume and write out |
| `--out <file>` | stdout | Write predictions JSON here |
| `--xmp <dir>` | — | Also write a Lightroom-readable `.xmp` sidecar per image into this dir |

`--treatment` is a genuine creative choice at inference time — at train time it is
read off the edit, but for a new frame nobody has decided colour vs B&W yet.

### The base rendering is written into the sidecar

Every predicted slider is relative to the rendering the photograph starts from,
and in ACR that is a camera profile *plus* an optional Look: "Adobe Color" is
`Adobe Standard v2` with a `<crs:Look>` element on top, not a `crs:CameraProfile`
value. Without an explicit profile in the sidecar Lightroom falls back to its own
legacy default (**Adobe Standard**), so a style learned on Adobe Color lands on a
different base and every slider is measured against the wrong starting point.

`predict` therefore writes the profile and replays the Look element verbatim, and
reports what it chose:

```
Rendering: Adobe Standard v2 + Adobe Color (208 images)
Rendering: Camera Faithful v2 (203 images)
```

An unedited file states no rendering, which is the normal case — the branch's
most common rendering stands in. `--camera-profile` overrides it and accepts
either a bare profile name or a full key:

```sh
shoots develop predict --data new.jsonl --profile profiles/my-style.json \
  --camera-profile "Adobe Standard v2 + Adobe Color" --xmp ./out-xmp/
```

A Look read from embedded crs (DNG/JPEG rather than a sidecar) has no element to
lift; `predict` emits the base profile and says so instead of pretending the
rendering is complete.

### The new set must use the same `--baseline` as the profile

An embedded camera JPEG and a neutral external render put the same photograph at
a different luminance, contrast and white point. A profile trained on one and
applied to the other reads a feature vector from a space it has never seen, and
the dimensions match either way, so nothing else can catch it. `predict` refuses
the pair outright:

```
error: profile was trained on baseline 'external' but the dataset was exported
with 'embedded-preview' — the colour features are not comparable across
baselines. Re-export with `--baseline external`.
```

The profile records which baseline it was trained on; pass the same flag when
exporting the set you want to predict on.

### Examples

```sh
# Export the new shoot, then predict. --baseline must match the profile's.
shoots develop export ~/Shoots/2026-07-new --baseline external --out new.jsonl

# Colour treatment, XMP sidecars for Lightroom
shoots develop predict --data new.jsonl --profile profiles/my-style.json \
  --treatment color --xmp ./out-xmp/

# Predictions as JSON for inspection
shoots develop predict --data new.jsonl --profile profiles/my-style.json \
  --out predictions.json

# A B&W variant of the same set
shoots develop predict --data new.jsonl --profile profiles/my-style.json \
  --treatment bw --xmp ./out-xmp-bw/
```

`--xmp` drops a Lightroom-readable sidecar next to each image — a **non-destructive
starting point** to refine, not a finished edit.

---

## `shoots develop feedback`

Compare a prediction against what the files say **now** — the only real-world
quality signal this tool has.

```
shoots develop feedback --predictions <file> [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--predictions <file>` | **required** | The JSON written by `develop predict --out` |
| `--editor <id>` | `acr` | Which editor's develop settings to read |
| `--out <file>` | — | Write this run's (predicted, corrected) pairs here as JSONL |
| `--journal <file>` | `~/.shoots/develop/feedback.jsonl` | Journal to accumulate into |
| `--no-journal` | off | Measure this run without recording it |
| `--min-moved <n>` | scaled to the pool | Comparisons a parameter needs to be listed |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

### It accumulates — one shoot is not a measurement

A per-parameter "kept %" over six images has a fifteen-point standard error, so
the table has a floor under it. A shoot of ten photographs can never clear a flat
floor of 20, which is why every run is also written to the journal and the
breakdown is computed over **everything recorded so far** — this run's own
acceptance is reported separately, above it.

Observations are per image and say nothing about which shoot they came from, so
ten shoots of eight are worth as much as one shoot of eighty. An amateur with
small sets still gets an answer; it just takes six months instead of one
afternoon.

- The floor scales with the pool: never fewer than 3, never more than a quarter
  of it, never more than 20. `--min-moved` overrides it.
- Rows marked `·` cleared the floor on fewer than 20 comparisons — directional,
  not yet a rate.
- Newest wins per file, so re-running feedback on a shoot corrects the old
  observation instead of counting it twice.
- `develop status` reports how far the journal has got. `develop clean` never
  removes it, `--all` or not: it records what photographs looked like the day
  they were developed, and nothing can rebuild that.

### Why it is not `refresh-targets`

`refresh-targets` rebuilds a dataset to match the files as they are now, which
throws away exactly what matters here: what they were **before** you touched
them. The pair (predicted, corrected) isolates *the model's* error rather than
your style, and it is worth more per sample than a fresh catalog edit.

### Reading it

```
  this shoot  kept 3.4% of the parameters either of us moved
              (58.4% counting the sliders we both left at neutral —
               that number flatters the model and is not the one to quote)
  journal     kept 3.6% over 21 images from 2 shoots

  over the journal (21 images), listed from 6 comparisons up:

  param                           moved   kept   journey   corrected by   offset
  Temperature                       590     0%       91%         463.21   +86.62
  Highlights2012                    590     0%       51%          21.54    +4.16
  Clarity2012                       251     0%      -12%           8.27    -0.14
  Dehaze                             14·    7%       22%           6.02    +1.30
```

| Column | Meaning |
| --- | --- |
| `moved` | Comparisons where at least one of you left neutral. Agreeing that a slider stays at zero is not a prediction. `·` marks fewer than 20 — directional, not yet a rate. |
| `kept` | Left untouched — the product metric. Held-out skill is its proxy. |
| `journey` | How much of the move the prediction already made. Negative = further off than doing nothing. |
| `corrected by` | Mean absolute correction, in slider units |
| `offset` | Mean **signed** correction. A large offset with a small spread is a missing constant, not a modelling failure — and a constant is easy to fix. |

> **What it cannot tell.** This compares a prediction against whatever the file
> says today. If the sidecar was never imported and the photograph was edited
> from scratch, the gap is two independent opinions rather than the model's
> error. Run it on a set you actually developed *from* the sidecars.

---

## `shoots develop calibrate`

Fold the feedback journal back into the profile as **per-parameter offsets** —
the only step that improves predictions from evidence the catalog does not
contain.

```
shoots develop calibrate [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--profile <file>` | `~/.shoots/develop/profile/export.json` | Profile to calibrate |
| `--journal <file>` | `~/.shoots/develop/feedback.jsonl` | Journal to read |
| `--shrink <n>` | `0.5` | Fraction of each measured correction to apply |
| `--min-shoots <n>` | `4` | Shoots a parameter needs before it is offset |
| `--include-in-sample` | off | Also use observations the model was already fitted on (optimistic — it says so) |
| `--imported-only` | off | Use only observations still carrying the rendering `predict` wrote |
| `--reset` | off | Remove the calibration, leaving the model as trained |
| `--dry-run` | off | Show the decision, write nothing |
| `--json` | off | Machine-readable JSON on stdout |

### Reading it

```
  journal: 21 images from 2 shoots
  21/21 still carry the rendering we wrote (100% — evidence the sidecars were imported)
  applying 50% of each measured correction, from 10 comparisons up

  color — 385 images across 5 shoots, 3 parameters offset
    param                        shoots   up/down   sigma   measured   applied
    SplitToningShadowHue              5      0/5      2.2     -18.71     -9.36
    Saturation                        5      5/0      2.2      +3.71     +1.85
    Contrast2012                      5      4/1      1.3      +1.18      0.00   (no direction)
```

| Column | Meaning |
| --- | --- |
| `shoots` | **Shoots** behind the estimate, not photographs — a take edited by pasting settings across it is one decision, not four hundred |
| `up/down` | How the *shoots* split by direction. This is the test: a lopsided split is a habit, an even one is one job differing from another |
| `sigma` | How lopsided, in standard deviations of a fair coin. Below 2 nothing is applied — which puts the hard floor at four shoots, since three unanimous only reach 1.73 |
| `measured` | Median across shoots, of the median within each shoot. Median at both levels, so neither one odd frame nor one odd job can drag it |
| `applied` | …after `--shrink`. Half, by default |

White balance is corrected as a **ratio**, not in absolute Kelvin: Temperature is
anchored to the as-shot value and lives in log-Kelvin, so a constant there is a
multiplier. The `measured` column shows log units for those parameters.

### One shoot is one vote

A take is edited by pasting settings across it, so counting photographs counts a
single styling decision hundreds of times. Measured on a simulated wedding — 400
frames pushed +6 against two smaller shoots pulling −5 and −6 — counting per
photograph reported **16 sigma** of confidence and applied **+3, the direction
two shoots out of three disagreed with**. Per shoot the same evidence gives 0.6
sigma and applies nothing, which is the honest answer for three shoots.

This is the reasoning that already makes the trainer hold out whole folders. It
matters to an amateur too: six shoots of eight frames are six votes, not 48.

What counts as held out is **where the prediction came from**, not where the
photograph ended up. A pair recorded before its photograph became training data
stays a genuine measurement forever — folding the file in afterwards cannot reach
back and change a number already written down. Only a prediction made by a model
that had *already* seen that photograph's answer is worthless, which takes going
round the loop twice on one shoot — a fresh `develop edit` **after** a `learn`.

`feedback` decides it by comparing two instants: the one `predict` stamped on the
prediction record, and the one `learn` recorded when it folded the photograph into
training. Later prediction ⇒ in-sample. Re-running `feedback` on a record that has
not changed is therefore not going round the loop again, and does not cost the
shoot its evidence. `--include-in-sample` uses the in-sample pairs anyway.

### Why it only ever proposes a constant

The photographer edits *from* the sidecar, so every observation is partly a
reaction to what was proposed rather than an independent opinion. Feeding that
back as ground truth teaches the model its own output was right — repeat it and
the predictions stop tracking the photographs and start tracking themselves.

An offset is the one correction where that anchoring is **safe**: a photographer
who accepts a value they would have pushed further only makes the measured offset
*smaller*, so the estimate errs toward under-correcting. Applying half of it
means calibrating again after the next shoot takes half of what is left — the
loop converges (measured: exactly 0.50× residual per round) rather than
overshoots.

Growing the training set with the developed shoot is the other half of the idea
and is deliberately **not** this command: that is `export` + `train`, on files
you *edited* rather than files you *approved*.

> The offsets sit beside the model in `profile.calibration`, never merged into
> its weights — `--reset` takes them back, `predict` reports how many it carries,
> and a retrain invalidates them (both `predict` and `status` say so).

---

## `shoots develop refine`

Close the loop on a shoot you have developed: `feedback` → `learn` → `calibrate`,
with the conventional paths, in the only order that works.

```
shoots develop refine <shoot> [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `<shoot>` | **required** | The folder you ran `develop edit` on and have since developed |
| `--measure-only` | off | Stop after `feedback`: record what you kept, change nothing |
| `--shoot-dir <dir>` | conventional | The shoot's working directory, if not the usual one |
| `--data`, `--profile`, `--journal` | conventional | Paths for the three steps |
| `--dry-run` | off | Print the steps and the paths, write nothing |

It also takes the flags of the steps it wraps: `--min-weight` / `--max-weight`
(from `learn`), `--shrink` / `--min-shoots` (from `calibrate`), and the `train`
flags `--lambda`, `--folds`, `--group-by`, `--gate-threshold`, `--embedding-dim`.

### Why the order is fixed

| Step | Why there |
| --- | --- |
| `feedback` | The only step that captures the (predicted, corrected) pair. The journal outlives `clean`; the shoot's working files do not. |
| `learn` | Refits with the shoot folded in, weighted. The only step that moves the part of the prediction that varies photograph to photograph. |
| `calibrate` | Re-measures the constant offsets **against the model that just came out of `learn`**. |

`learn` writes a whole new profile, so a `calibrate` run before it is silently
thrown away. That is the whole reason this command exists.

> **Expect `calibrate` to say nothing for your first three shoots.** Four is the
> statistical floor for an offset, not a policy — three shoots agreeing
> unanimously only reach 1.73 sigma. Steps 1 and 2 do their full work on every
> pass regardless, and the journal only grows, so from the fourth shoot on the
> third step contributes too and keeps contributing. `refine` reports it and
> exits successfully either way.

### Repeating it on the same shoot

`refine` stores nothing twice — the journal and the training dataset are both keyed
by absolute file path, newest wins — and repeating it is **safe**, but it is not
free.

Safe, because of how "in-sample" is decided. An observation is worthless only when
its *prediction* came from a model that had already been fitted on that photograph,
so `feedback` compares the instant `predict` stamped on the record against the
instant `learn` folded the photograph in, and marks it in-sample only when the
prediction is the later of the two. Re-measuring a prediction that has not changed
therefore stays the clean held-out measurement it was — including after `learn` has
folded the shoot in. Only genuinely re-running `develop edit` **after** a `learn`
produces an in-sample pair, which is the one case that cannot measure anything.

> Journals written before this existed have no timestamps to compare and fall back
> on the boolean recorded at the time. If a repeated `refine` has already marked a
> shoot in-sample, one more `feedback` on it re-measures and clears the flag —
> under the scheduler that needs `shoots schedule run --force`, since an unchanged
> shoot is otherwise skipped.

Not free, because `learn` refits, and a refit writes a whole new profile — which
discards the calibration offsets measured against the old one. On identical data
that is minutes of work to arrive where you already were. Run it once per shoot you
develop, and let [`shoots schedule`](./schedule.md) decide when: it skips a shoot
whose photographs and sidecars have not moved since the last pass.

---

## `shoots develop learn`

Fold a shoot you have already developed back into the training set — **weighted
by how much of the prediction you had to change** — and refit the profile.

```
shoots develop learn <shoot> [options]
```

`calibrate` moves the *average* of the predictions. It cannot move the part that
varies photograph to photograph, because a constant cannot track a variable —
and that varying part is most of what anyone would call an eye. Only refitting
the model moves it, and this is the refit.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `<shoot>` | **required** | The folder you ran `develop edit` on and have since developed |
| `--data <file>` | `~/.shoots/develop/export/export.jsonl` | Training dataset to fold into |
| `--out <file>` | `~/.shoots/develop/profile/export.json` | Profile to refit |
| `--shoot-dir <dir>` | conventional | The shoot's working directory, if not the usual one |
| `--min-weight <n>` | `0.25` | Floor for a frame you accepted wholesale |
| `--max-weight <n>` | `3` | Ceiling for a frame you overhauled |
| `--no-train` | off | Update the dataset but stop before refitting |
| `--dry-run` | off | Show the weighting and the plan, write nothing |
| `--name`, `--lambda`, `--folds`, `--group-by`, `--gate-threshold`, `--embedding-dim`, `--all` | — | As [`train`](#shoots-develop-train) |

Nothing is recomputed: `develop edit` already left the shoot's embeddings and
colour features on disk, and only the *targets* changed when you developed the
photographs. They are re-read from the sidecars and merged by file — same file
twice means the newer state wins.

### Reading it

```
  12 developed frames, weighted by how much you changed:
    1 you overruled     (weight ≥ 1.5 — these drive the refit)
    11 you adjusted      (around 1, like an ordinary catalog edit)
    0 you accepted      (weight ≤ 0.6 — mostly our own output coming back)

    file                                weight   correction
    R-5686.CR3                           1.80         0.38
    R-5682.CR3                           1.34         0.29
    R-5692.CR3                           0.81         0.17
    (correction 1.00 = the median for this shoot, 0.2132 in standardized units)
```

### Why the weight is the whole point

```
z_i      = mean over parameters of |actual − predicted| / spread(parameter)
weight_i = clamp(z_i / median(z), 0.25, 3)
```

Editing *from* a prediction contaminates the target: a frame you accepted almost
untouched is largely the model's own output coming back as ground truth, and a
model trained on its own predictions collapses onto its own habits. Those are
exactly the frames with the smallest correction — **so weighting by correction
size down-weights the contaminated samples without having to identify them**. The
frames that dominate the refit are the ones where you overruled the model: the
least anchored and the most informative at once.

Normalizing against the *median* correction rather than an absolute scale keeps
this working as the model improves — when predictions get better every correction
shrinks, and a fixed scale would quietly stop weighting anything.

> **Weights are in the fit, never in the score.** Letting them into the held-out
> error would let the same choice that emphasized a row also decide how well the
> model did on it. The GATE keeps measuring what it always measured, so before
> and after are comparable. Standardization stays unweighted too, so a corrected
> shoot cannot quietly redefine the constant a gated parameter emits — that is
> `calibrate`'s job.

> **A refit invalidates the calibration**: its offsets described a model that no
> longer exists. The order is refit → develop a shoot → `feedback` → `calibrate`.

---

## `shoots develop diagnose`

Style-clustering diagnostic: compares **pooled** prediction skill against
**per-style (clustered)** skill.

```
shoots develop diagnose --data <file> [options]
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `--data <file>` | **required** | Dataset from `develop export` |
| `--folds <k>` | `5` | Cross-validation folds |
| `--max-k <k>` | `4` | Max number of style clusters to try |

Use it when pooled training underperforms. If clustered skill is clearly better,
your catalog holds **several distinct looks** (a moody set and an airy set, say),
and a single pooled model is averaging them into mush. The fix is to split the
catalog and train one profile per look.

```sh
shoots develop diagnose --data train.jsonl
shoots develop diagnose --data train.jsonl --max-k 6 --folds 10
```

---

## Doing it by hand

The everyday pipeline at the top of this page is these steps with the paths
filled in. Reach for them directly when you want a dataset somewhere specific, a
second profile, or the diagnostic in between:

```sh
# 1. Training dataset from your edited catalog
shoots develop export ~/Catalogs/2025-edited --edited-only   --baseline external --out train.jsonl

# 2. Fit the profile — read the GATE output carefully
shoots develop train --data train.jsonl --name my-style --out profiles/my-style.json

# 2b. Weak result? Check whether you have multiple styles
shoots develop diagnose --data train.jsonl

# 3. Export the new shoot. Same --baseline as step 1, or predict refuses the pair.
shoots develop export ~/Shoots/2026-07-new --baseline external --out new.jsonl

# 4. Predict, as XMP sidecars — keep --out, `feedback` needs it later
shoots develop predict --data new.jsonl --profile profiles/my-style.json   --treatment color --xmp ./out-xmp/ --out predictions.json

# 5. After developing them, see how much of the prediction survived
shoots develop feedback --predictions predictions.json
```

Upgrading, rather than starting fresh? When the *target* side changed — a fixed
tag, a new schema parameter, a stricter "edited" test — step 1 is
`refresh-targets` instead of a re-export, and the features are reused:

```sh
shoots develop refresh-targets --data train.jsonl --out train-v2.jsonl
shoots develop train --data train-v2.jsonl --name my-style --out profiles/my-style.json
```

---

## See also

- [Develop predictor guide](../develop-predictor.md) — what is predicted and why
- [Configuration](../configuration.md) — `SHOOTS_RAW_DEVELOPER` and friends
