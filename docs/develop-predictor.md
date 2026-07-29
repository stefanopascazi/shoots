# Develop predictor — the local "Lightroom AI"

A personal **develop-setting predictor**: it learns your develop style from your
own catalog and predicts a per-image develop starting point for a new shoot.

Command reference: [`shoots develop`](./commands/develop.md).

---

## Scope — read this first

**What it does:** predicts the *global look* as an Adobe Camera Raw (process 2012)
develop vector, and writes it as an `.xmp` sidecar.

**What it does not do:** local masks, generative edits, retouching, or a finished
edit. The goal is **the best starting point to refine**, not a delivered image.

**It is editor-agnostic.** The engine runs without any host editor installed. XMP
sidecars are the interface — Lightroom, Bridge and Capture One read them. Plugins
for specific editors are thin fronts over this same engine, not a dependency of it.

---

## What is predicted

The develop vector splits into two **branches** by treatment. The split is
deterministic from the edit itself: black-and-white uses the GrayMixer, colour uses
HSL, and they are mutually exclusive.

### `shared` — predicted for every photo

| Group | Parameters |
| --- | --- |
| Tone | `Exposure2012`, `Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Blacks2012` |
| Presence | `Texture`, `Clarity2012`, `Dehaze` |
| White balance | `Temperature`, `Tint` |
| Parametric curve | `ParametricHighlights`, `ParametricLights`, `ParametricDarks`, `ParametricShadows` |
| Calibration | `ShadowTint`, `RedHue`, `RedSaturation`, `GreenHue`, `GreenSaturation`, `BlueHue`, `BlueSaturation` |
| Effects | `PostCropVignetteAmount`, `GrainAmount` |

### `color` — colour photos only

`Vibrance`, `Saturation`, the **24 HSL adjustments** (Hue/Saturation/Luminance ×
Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta), colour grading
(shadow/midtone/highlight/global — hue, sat, lum, plus blending and balance), and
split toning.

### `bw` — black-and-white photos only

The 8-channel grayscale mixer.

One ridge model is trained **per treatment** over `shared + <branch>`, so a
high-contrast B&W edit and a light colour edit never average into a mush.

### Captured but not predicted

The full edit *is* captured in the dataset — including sharpening, noise reduction
and the base `CameraProfile` — but only the look above is *learned as a target*.
Sharpening and noise reduction are **finishing**, not starting point.

The exact list, ranges, branches and loss weights live in
`packages/cli/src/develop/develop/schema.ts`.

---

## Two design decisions

### 1. Deltas, not absolutes

For sliders the neutral default is 0, so the delta *is* the value.

**White balance is the exception, and it is the single biggest accuracy lever.**
Temp/Tint are camera-calibration-relative — 5200K on a Canon is not 5200K on a
Sony. So WB is measured against the **as-shot** WB, with temperature in
log-Kelvin. Predicting absolute Temperature would mostly learn which camera took
the picture.

### 2. Per-parameter standardization + loss weighting

Parameter ranges differ wildly (`Exposure2012` spans −5..5, `Contrast2012` spans
−100..100). Each parameter's delta is z-scored so no single one dominates by unit
scale alone.

The go/no-go metric then **weights the image-dependent parameters** — exposure,
WB, contrast, highlights/shadows, dehaze/vibrance — and *expects* style-constant
parameters (HSL, colour grading) to collapse to your mean.

> A style-constant parameter collapsing to your mean is **correct, not a failure.**
> If you always apply the same subtle orange-shift to skin tones, "predict the
> mean" is the right answer and there is no image-dependent signal to find.

---

## The go/no-go GATE

`shoots develop train` reports, per parameter:

- the held-out **MAE of the model**,
- the MAE of the **"apply my average edit"** baseline,
- a **skill** score: `1 − modelMae / baselineMae`,
- the **ridge strength λ** that parameter was fitted with.

`skill > 0` means the model beats simply applying your mean edit.

λ is chosen **per parameter**, because exposure and the HSL sliders do not want
the same amount of shrinkage and one shared λ is picked by an average the
unpredictable majority dominates. The gate pays for that search: λ is re-chosen
inside each held-out fold, so no parameter is scored on the split that picked it.

**The headline number is the weighted skill over the image-dependent parameters.**

| Headline skill | Reading |
| --- | --- |
| Clearly positive | GO. There is real per-image signal. |
| Around zero | The model is no better than your average edit. |
| Negative | Something is wrong — check the baseline strategy and the dataset. |

If it is not clearly positive on a real catalog, **stop**. The signal is too weak
to build on, and the first thing to reconsider is the baseline render strategy.

---

## The baseline render — why it matters most

The photometric features must come from a render of the image **before** the edit.
Get this wrong and everything downstream is noise.

### `--baseline embedded-preview` (default)

Uses the RAW's embedded JPEG preview.

- ✅ Zero setup, fast.
- ❌ An **approximation**. The preview bakes in the camera's per-model picture
  style, which pollutes the exposure and tone features.
- Expect absolute-luminance parameters (`Exposure2012`, `Whites2012`,
  `Blacks2012`) to stay near your photographer mean — the features simply do not
  carry the information needed to do better.

Fine for a **first signal**. Not the configuration to judge the method on.

### `--baseline external`

A stand-alone RAW developer produces a **neutral, camera-independent** render:
standard colour, camera WB, and crucially **no auto-brighten**, so the true scene
exposure survives into the features.

Zero-config — on first use it provisions LibRaw's `dcraw_emu` into `~/.shoots`,
checksum-verified from the mirror, exactly like exiftool. `shoots setup` fetches it
up front.

Override with your own developer, no editor involved:

```sh
# A local LibRaw dcraw_emu (needs LibRaw ≥ 0.20 for CR3)
export SHOOTS_RAW_DEVELOPER=dcraw_emu
# default args already target dcraw_emu: -w -W -o 1 -q 0 -T -Z {out} {in}

# …or RawTherapee-cli with a neutral profile
export SHOOTS_RAW_DEVELOPER=rawtherapee-cli
export SHOOTS_RAW_DEVELOPER_ARGS='-Y -q -o {out} -p neutral.pp3 -c {in}'
```

`{in}` / `{out}` are substituted per file; renders go to a temp dir. Only RAW files
are re-rendered — rendered formats use their own pixels. CLIP always stays on the
embedded preview, because it is colour-invariant and the extra render would buy
nothing.

The chosen strategy is recorded in both the dataset and the profile — and
`predict` **refuses** a profile and a dataset that disagree. The two renders put
the same photograph at a different luminance, contrast and white point, so a
profile trained on one reads a feature vector from a space it never saw. The
dimensions match either way, which is precisely why nothing else can catch it:

```
error: profile was trained on baseline 'external' but the dataset was exported
with 'embedded-preview' — the colour features are not comparable across
baselines. Re-export with `--baseline external`.
```

Export the set you predict on with the same `--baseline` you trained with.

### Target leak

For proprietary RAW (CR3/NEF/ARW) the embedded preview is the **camera JPEG** —
edit-independent, so there is no leak.

**DNG is the risk.** A DNG whose preview has been updated by the editor bakes the
edit into the "before" render, and the model appears to work brilliantly while
having learned nothing. If your catalog is DNG, verify this before trusting a
result.

---

## Complete workflow

```sh
# 1. Training dataset from an edited catalog.
#    --edited-only reads crs from the cheap sidecars first and runs the expensive
#    work only on files that actually carry develop settings.
shoots develop export ~/Catalogs/2025-edited --edited-only \
  --baseline external --out train.jsonl

# 2. Fit the profile. Read the GATE output.
shoots develop train --data train.jsonl --name my-style --out profiles/my-style.json

# 3. Export the NEW set (no --edited-only — nothing is edited yet).
#    Same --baseline as step 1, or predict will refuse the pair.
shoots develop export ~/Shoots/2026-07-new --baseline external --out new.jsonl

# 4. Predict — pick the treatment, write XMP sidecars.
shoots develop predict --data new.jsonl --profile profiles/my-style.json \
  --treatment color --xmp ./out-xmp/
```

Import the sidecars in Lightroom and every frame opens on your look, ready to
refine.

---

## When the result is weak

### 1. Switch the baseline

`embedded-preview` → `external` is the largest single improvement available, and
the first thing to try.

```sh
shoots develop export ~/Catalogs/2025-edited --edited-only \
  --baseline external --out train-neutral.jsonl
shoots develop train --data train-neutral.jsonl --name my-style-v2 \
  --out profiles/my-style-v2.json
```

### 2. Check for multiple styles

```sh
shoots develop diagnose --data train.jsonl
```

This compares **pooled** skill against **per-style (clustered)** skill. If
clustered is clearly better, your catalog holds several distinct looks — a moody
set and an airy set, editorial and personal work — and a single pooled model is
averaging them into mush.

The fix is to split the catalog and train one profile per look.

```sh
shoots develop diagnose --data train.jsonl --max-k 6 --folds 10
```

### 3. More edited images

Ridge regression over hundreds of parameters needs a real catalog. A few dozen
edits will not produce a stable model.

### 4. Check consistency

If you genuinely edit each image on its own terms with no through-line, there may
be no style to learn. That is a legitimate finding, not a bug.

---

## Known limits (v1)

- **Hue parameters are modelled linearly** although they are circular (0–360°) —
  colour grade, calibration and split-tone hues. Acceptable while they are
  near-constant per catalog, wrong if you swing hue wildly per image.
- **The point tone curve is captured, not predicted.** It is recorded in the
  dataset as `curve` but is not a target in v1.
- **Global look only.** No local adjustments, no masks, no AI subject selection.
- **One profile per style.** The model has no per-image style routing; at
  inference you choose the treatment.

---

## See also

- [`shoots develop`](./commands/develop.md) — full command reference
- [Configuration](./configuration.md) — `SHOOTS_RAW_DEVELOPER`, `SHOOTS_LIBRAW`
- `packages/cli/src/develop/develop/schema.ts` — the exact target vector
