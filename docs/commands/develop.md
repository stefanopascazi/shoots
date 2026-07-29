# `shoots develop`

Personal **develop-setting predictor** — the local "Lightroom AI", limited to the
*global look*. It learns your develop style from your own catalog and predicts a
per-image starting point for a new shoot.

```
shoots develop <subcommand> [options]
```

| Subcommand | Purpose |
| --- | --- |
| [`export`](#shoots-develop-export) | Build a training dataset from an edited catalog |
| [`refresh-targets`](#shoots-develop-refresh-targets) | Re-read an existing dataset's targets without recomputing pixels |
| [`train`](#shoots-develop-train) | Fit a per-catalog develop profile |
| [`predict`](#shoots-develop-predict) | Apply a profile → predicted develop vector / XMP sidecar |
| [`feedback`](#shoots-develop-feedback) | Compare a prediction against what you actually kept |
| [`diagnose`](#shoots-develop-diagnose) | Style-clustering diagnostic |

`export` is the only step that touches ONNX / exiftool for pixels;
`refresh-targets` needs exiftool but no image decoding. `train`, `predict` and
`diagnose` are pure maths over the exported dataset.

For the conceptual background — what is predicted, why deltas, how to read the
go/no-go metric — see the [Develop predictor guide](../develop-predictor.md).

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
| `--out <file>` | — | Write the (predicted, corrected) pairs here as JSONL |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

### Why it is not `refresh-targets`

`refresh-targets` rebuilds a dataset to match the files as they are now, which
throws away exactly what matters here: what they were **before** you touched
them. The pair (predicted, corrected) isolates *the model's* error rather than
your style, and it is worth more per sample than a fresh catalog edit.

### Reading it

```
  kept 3.5% of the parameters either of us moved
       (55.1% counting the sliders we both left at neutral —
        that number flatters the model and is not the one to quote)

  param                           moved   kept   journey   corrected by   offset
  Temperature                       590     0%       91%         463.21   +86.62
  Highlights2012                    590     0%       51%          21.54    +4.16
  Clarity2012                       251     0%      -12%           8.27    -0.14
```

| Column | Meaning |
| --- | --- |
| `moved` | Comparisons where at least one of you left neutral. Agreeing that a slider stays at zero is not a prediction. |
| `kept` | Left untouched — the product metric. Held-out skill is its proxy. |
| `journey` | How much of the move the prediction already made. Negative = further off than doing nothing. |
| `corrected by` | Mean absolute correction, in slider units |
| `offset` | Mean **signed** correction. A large offset with a small spread is a missing constant, not a modelling failure — and a constant is easy to fix. |

> **What it cannot tell.** This compares a prediction against whatever the file
> says today. If the sidecar was never imported and the photograph was edited
> from scratch, the gap is two independent opinions rather than the model's
> error. Run it on a set you actually developed *from* the sidecars.

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

## Complete pipeline

```sh
# 1. Training dataset from your edited catalog.
shoots develop export ~/Catalogs/2025-edited --edited-only   --baseline external --out train.jsonl

# 2. Fit the profile — read the GATE output carefully
shoots develop train --data train.jsonl --name my-style --out profiles/my-style.json

# 2b. Weak result? Check whether you have multiple styles
shoots develop diagnose --data train.jsonl

# 3. Export the new shoot. Same --baseline as step 1, or predict refuses the pair.
shoots develop export ~/Shoots/2026-07-new --baseline external --out new.jsonl

# 4. Predict, as XMP sidecars
shoots develop predict --data new.jsonl --profile profiles/my-style.json \
  --treatment color --xmp ./out-xmp/
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
