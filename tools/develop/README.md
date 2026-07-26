# shoots-develop

Personal **develop-setting predictor** for [Shoots](../../README.md) — the "local
Lightroom AI" editor, limited to the *global look* (no local masks, no generative
edits). It learns a photographer's develop style from their own catalog and
predicts a per-image develop starting point for a new set.

It is deliberately **separate from the Shoots monorepo**: its own `package.json`,
its own build. It never loads onnxruntime — the heavy feature extraction (CLIP +
color features + crs targets) lives in the `shoots develop-export` command; this
tool only does the math (a multi-output ridge over develop-setting *deltas*).

Licensed **PolyForm-Noncommercial-1.0.0** (inherited from the repo). The only
runtime dependency is `commander` (MIT).

## Pipeline

```
# 1. In the Shoots CLI — build the training dataset from an edited catalog
#    (RAW/edited images carrying crs develop settings in their XMP):
shoots develop-export <edited-catalog> --out train.json

# 2. Fit the per-catalog develop profile (prints the go/no-go evidence):
develop train --data train.json --name my-style --out profiles/my-style.json

# 3. Export a NEW set the same way, then predict its develop settings:
shoots develop-export <new-shoot> --out new.json
develop predict --data new.json --profile profiles/my-style.json --xmp out-xmp/
```

`predict --xmp` drops a Lightroom-readable `.xmp` sidecar next to each image — a
non-destructive starting point. (The Lua plugin of the full plan applies these via
the official SDK; the sidecar is the CLI-only path.)

## What it predicts

An Adobe Camera Raw (process 2012) develop vector — tone (exposure, contrast,
highlights/shadows/whites/blacks), presence (texture/clarity/dehaze/vibrance/
saturation), white balance (temp/tint), the 24 HSL adjustments, color grading, and
the parametric tone curve. See `src/develop/schema.ts` for the exact list, ranges
and per-parameter loss weights.

Two decisions are baked into the model:

- **Deltas, not absolutes.** For sliders the neutral default is 0, so delta ==
  value. White balance is measured against the *as-shot* WB (temperature in
  log-Kelvin), because Temp/Tint are camera-calibration-relative — the single
  biggest accuracy lever.
- **Per-parameter standardization + loss weighting.** Ranges differ wildly, so
  each parameter's delta is z-scored. The go/no-go metric weights the
  *image-dependent* parameters (exposure, WB, contrast, highlights/shadows,
  dehaze/vibrance) and expects style-constant parameters (HSL, color grading) to
  collapse to the photographer's mean — that is correct, not a failure.

## The go/no-go metric (Fase 0 GATE)

`develop train` reports, per parameter, the held-out **MAE of the model** versus
the **"apply my average edit"** baseline, and a **skill** score
`1 − modelMae/baselineMae`. Skill > 0 means the model beats the mean. The headline
number is the weighted skill over the image-dependent parameters. If that is not
clearly positive on a real catalog, the signal is too weak to build the plugin on
— stop and reconsider the baseline render strategy.

## Baseline render caveat

`shoots develop-export` currently renders the baseline from the RAW's **embedded
JPEG preview** (`--baseline embedded-preview`). This is an *approximation*: a
colorimetrically correct neutral baseline needs Lightroom (virtual-copy reset) or
an external RAW developer. The chosen strategy is recorded in the dataset so the
evaluation is read with the right caveat. If the embedded preview reflects the
*current edit* (some catalogs bake the edit into the preview), it can leak the
target — check this before trusting a high skill score.
