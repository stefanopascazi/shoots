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
| [`train`](#shoots-develop-train) | Fit a per-catalog develop profile |
| [`predict`](#shoots-develop-predict) | Apply a profile → predicted develop vector / XMP sidecar |
| [`diagnose`](#shoots-develop-diagnose) | Style-clustering diagnostic |

`export` is the only step that touches ONNX / exiftool. `train`, `predict` and
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

**Use it for training-set builds.** Do *not* use it when exporting a new,
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
  "baseProfile": "Camera Faithful v2",
  "curve": [0, 0, 32, 22, 128, 128, 255, 255]
}
```

| Field | Meaning |
| --- | --- |
| `develop` | The `crs` settings present on the file. Absent keys are neutral. |
| `asShot` | Camera reference state — the delta reference for white balance |
| `treatment` | `color` or `bw`, derived deterministically from the edit (GrayMixer ⇒ bw) |
| `baseProfile` | The `crs:CameraProfile` the edit sat on |
| `curve` | Flattened point tone curve `[x0,y0,x1,y1,…]`; absent when linear/default |

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

One model is trained **per treatment** over `shared + <branch>`, so a
high-contrast B&W edit and a light colour edit never average into a mush.

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
# 1. Training dataset from your edited catalog
shoots develop export ~/Catalogs/2025-edited --edited-only --out train.jsonl

# 2. Fit the profile — read the GATE output carefully
shoots develop train --data train.jsonl --name my-style --out profiles/my-style.json

# 2b. Weak result? Check whether you have multiple styles
shoots develop diagnose --data train.jsonl

# 3. Export the new shoot
shoots develop export ~/Shoots/2026-07-new --out new.jsonl

# 4. Predict, as XMP sidecars
shoots develop predict --data new.jsonl --profile profiles/my-style.json \
  --treatment color --xmp ./out-xmp/
```

---

## See also

- [Develop predictor guide](../develop-predictor.md) — what is predicted and why
- [Configuration](../configuration.md) — `SHOOTS_RAW_DEVELOPER` and friends
