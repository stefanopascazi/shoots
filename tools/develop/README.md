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
# 1. In the Shoots CLI — build the training dataset from an edited catalog.
#    --edited-only reads crs from the (cheap) sidecars first and runs the
#    expensive work only on files that actually carry develop settings:
shoots develop-export <edited-catalog> --edited-only --out train.jsonl

# 2. Fit the per-catalog develop profile (prints the go/no-go evidence per branch):
develop train --data train.jsonl --name my-style --out profiles/my-style.json

# 3. Export a NEW set, then predict — pick the treatment (colour/B&W) or auto:
shoots develop-export <new-shoot> --out new.jsonl
develop predict --data new.jsonl --profile profiles/my-style.json --treatment color --xmp out-xmp/
```

`predict --xmp` drops a Lightroom-readable `.xmp` sidecar next to each image — a
non-destructive starting point. (The Lua plugin of the full plan applies these via
the official SDK; the sidecar is the CLI-only path.)

## What it predicts

The **starting-point global look**, as an Adobe Camera Raw (process 2012) develop
vector, split into two branches by treatment (deterministic from the edit —
black-and-white uses the GrayMixer, colour uses HSL; they are mutually exclusive):

- **shared** (every photo): tone (exposure, contrast, highlights/shadows/whites/
  blacks), presence (texture/clarity/dehaze), white balance, the parametric tone
  curve, camera calibration, vignette/grain.
- **colour** only: vibrance/saturation, the 24 HSL adjustments, colour grading
  (shadow/mid/highlight/global) and split toning.
- **B&W** only: the 8-channel grayscale mixer.

One ridge model is trained per treatment over `shared + <branch>`, so a
high-contrast B&W edit and a light colour edit never average into a mush. See
`src/develop/schema.ts` for the exact list, ranges, branches and loss weights.

The full edit is *captured* (incl. sharpening / noise reduction and the base
`CameraProfile`) but only the look above is *predicted* — the goal is the best
starting point to refine, not the finished edit. Sharpening/noise are finishing,
not starting point, so they are recorded in the dataset but not learned as targets.

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

## Baseline render

The photometric features must come from a render of the image *before* the edit.
Two strategies, editor-agnostic by design (no dependency on any host editor):

- **`--baseline embedded-preview`** (default): the RAW's embedded JPEG preview.
  Zero setup, but an *approximation* — the preview bakes in the camera's per-model
  picture style, which pollutes the exposure/tone features. Fine for a first
  signal; expect the absolute-luminance params (exposure/whites/blacks) to stay
  near the photographer mean.

- **`--baseline external`**: a stand-alone RAW developer produces a neutral,
  camera-independent render (standard color, camera WB, **no auto-brighten** so the
  true scene exposure survives). Configure it via env — no editor involved:

  ```bash
  # LibRaw dcraw_emu (fast, tiny; needs LibRaw ≥0.20 for CR3):
  export SHOOTS_RAW_DEVELOPER=dcraw_emu
  # default args already target dcraw_emu: -w -W -o 1 -q 0 -T -Z {out} {in}

  # …or RawTherapee-cli with a neutral profile:
  export SHOOTS_RAW_DEVELOPER=rawtherapee-cli
  export SHOOTS_RAW_DEVELOPER_ARGS='-Y -q -o {out} -p neutral.pp3 -c {in}'
  ```

  `{in}` / `{out}` are substituted per file; the render goes to a temp dir. Only
  RAW files are re-rendered (rendered formats use their own pixels); CLIP stays on
  the embedded preview (it is colour-invariant). A provisioned binary in `~/.shoots`
  (like exiftool) is the planned follow-up once the lever is confirmed.

The chosen strategy is recorded in the dataset and profile. Note: for proprietary
RAW (CR3/NEF/ARW) the embedded preview is the camera JPEG — edit-independent, so no
target leak; DNG with updated previews can leak and should be checked.
