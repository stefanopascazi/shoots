# shoots develop

Personal **develop-setting predictor** for [Shoots](../../../../README.md) — the
"local Lightroom AI" editor, limited to the *global look* (no local masks, no
generative edits). It learns a photographer's develop style from their own catalog
and predicts a per-image develop starting point for a new set.

It lives inside the Shoots CLI as the `shoots develop` command group. The heavy
feature extraction (CLIP + colour features + crs targets) is the `export`
subcommand — the only step that touches onnx/exiftool; `train`, `predict` and
`diagnose` are pure maths over the exported dataset (a multi-output ridge over
develop-setting *deltas*), reusing no ML runtime.

Licensed **PolyForm-Noncommercial-1.0.0** (inherited from the repo).

## Pipeline

```
# 1. Build the training dataset from an edited catalog.
#    --edited-only reads crs from the (cheap) sidecars first and runs the
#    expensive work only on files that actually carry develop settings:
shoots develop export <edited-catalog> --edited-only --baseline external --out train.jsonl

# 2. Fit the per-catalog develop profile (prints the go/no-go evidence per branch):
shoots develop train --data train.jsonl --name my-style --out profiles/my-style.json

# 3. Export a NEW set, then predict — pick the treatment (colour/B&W) or auto.
#    --baseline MUST match the one the profile was trained on; predict refuses
#    the pair otherwise (the colour features are not comparable across baselines).
shoots develop export <new-shoot> --baseline external --out new.jsonl
shoots develop predict --data new.jsonl --profile profiles/my-style.json --treatment color --xmp out-xmp/

# Changed the target side (a tag, a new parameter, a stricter "edited" test)?
# Re-read the targets in place instead of re-exporting: it keeps the embeddings
# and the neutral renders, turning hours back into minutes.
shoots develop refresh-targets --data train.jsonl --out train-v2.jsonl
```

`predict --xmp` drops a sidecar per image in the chosen editor's format (`acr` →
a Lightroom-readable `.xmp`) — a non-destructive starting point. (The Lua plugin
of the full plan applies these via the official SDK; the sidecar is the CLI-only
path.)

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

## Editors are adapters

Develop settings are not portable, and no file-format work makes them so. XMP is
only a container; `crs:` is Adobe's private vocabulary inside it; darktable keeps
a base64 module stack in a namespace of its own; Capture One does not put
adjustments in XMP at all. Deeper still, the numbers do not transfer even where
the names line up — `Exposure2012 +0.35` means what ACR's pipeline says it means.

So each editor gets an adapter (`src/develop/adapters/`), and the adapter is the
only code that knows. Schema, model, profile and evaluation stay in one
vocabulary — **ACR's**, because it is the de-facto lingua franca and the emit
path has to speak it regardless. `--editor <id>` selects one; `acr` is the only
one today. The `readEdits` / `readCapture` split is batch-shaped on purpose: it
is one exiftool pass over sidecars now, and one query against a Lightroom
`.lrcat` if that source is ever added (read-only — never write a user's catalog).

## The go/no-go metric (Fase 0 GATE)

`shoots develop train` reports, per parameter, the held-out **MAE of the model**
versus the **"apply my average edit"** baseline, and a **skill** score
`1 − modelMae/baselineMae`. The headline is the weighted skill over the
image-dependent parameters.

Three things make that number mean what it says, all learned by getting it wrong:

- **Whole capture sessions are held out** (`--group-by folder`, the default). A
  catalog is not i.i.d.: a shoot is dozens of near-identical frames, routinely
  edited by pasting settings across the take. Random folds put a frame's twin in
  the training set, and the model scores itself on photographs it has already
  seen. The random-fold number is printed alongside — the gap between them *is*
  the leakage, and on a real catalog it was 0.13 against a true 0.02.
- **The baseline lives in delta space** — the average *move*, decoded per image,
  not the average absolute value. Averaging absolute Kelvin charges the baseline
  with the spread of the as-shot anchor instead of the spread of the edit.
- **λ is re-chosen inside every held-out fold.** Regularization is picked per
  parameter (see below), and selecting it on the same folds that report the score
  hands each of ~90 parameters the best of six tries. That is enough noise on its
  own to push unpredictable sliders past a gate set at a couple of percent.

Targets that never move across the catalog are flagged `[never moves]` and kept
out of the headline: a constant is predicted perfectly by anything, so scoring it
rewards an exporter bug rather than a model.

If the grouped number is not clearly positive on a real catalog, the signal is
too weak to build the plugin on — stop and reconsider the baseline render
strategy.

## The base rendering: profile + Look

Every predicted slider is relative to the rendering the photograph starts from,
and in ACR that rendering is *two* things. `crs:CameraProfile` is only the base;
the modern creative profiles are a Look layered over it — "Adobe Color" is
`Adobe Standard v2` **plus** a `<crs:Look>` element, not a CameraProfile value of
its own. Reading the profile alone merges renderings that look nothing alike: on
a real catalog that mislabelled 206 of 428 colour edits, the largest single style
split in it.

So the conditioning vocabulary is the pair (`Adobe Standard v2 + Adobe Color`),
and three things follow:

- **The dataset carries the Look element**, once per distinct Look in the trailing
  meta line rather than once per photograph — it runs to ~1.4 KB and a 20k-image
  catalog would otherwise carry tens of megabytes of identical text.
- **The profile carries it too**, because a Look cannot be rebuilt from its name:
  Lightroom resolves it by UUID and look-table digest. It is replayed verbatim.
  A Look read from embedded crs (DNG/JPEG) has no element to lift, and `predict`
  says so rather than emitting a base profile as if it were the whole rendering.
- **`predict` writes it out.** Without an explicit profile Lightroom falls back to
  its own legacy default (Adobe Standard), so a style learned on Adobe Color
  arrived sitting on a different base — every slider measured against the wrong
  starting point, and nothing in the numbers to show it.

An unedited file states no rendering at all, which is the normal case here. The
branch's most common rendering stands in, so the model is asked the question it
was trained on. `--camera-profile "<name>"` overrides it — the way to aim a
profile at a rendering the catalog has moved on from. It takes either a bare
profile name or a full `profile + Look` key.

## Regularization is per parameter

Exposure and the HSL sliders do not want the same amount of shrinkage. One λ for
the whole vector is chosen by an average that the unpredictable majority
dominates, and on a real catalog that pinned λ to the top of the grid and
collapsed *every* parameter onto the photographer's mean — which from the outside
is indistinguishable from "it predicts the same settings for every photo".

So `--lambda auto` picks a λ per parameter. The normal equations do not depend on
λ, so this costs one Cholesky per *distinct* λ, never one per parameter. The
branch header reports how the choice came out:

```
λ per param (auto): 30000×62 100×6
```

Everything at the top of the grid means the model cannot read this catalog.

## Gating

Parameters whose held-out skill sits at or below `--gate-threshold` (default
0.02) are predicted as the photographer's own constant instead of the model
output. A prediction that scores below the mean is worse than no prediction: it
moves a slider away from where this photographer would have left it. The profile
records which parameters are gated, and `predict` honours the list.

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
  true scene exposure survives). **Zero-config**: on first use it provisions the
  LibRaw `dcraw_emu` binary into `~/.shoots` (checksum-verified from the mirror,
  exactly like exiftool — `shoots setup` fetches it up front). Override with your
  own developer via env — no editor involved:

  ```bash
  # A local LibRaw dcraw_emu (needs LibRaw ≥0.20 for CR3):
  export SHOOTS_RAW_DEVELOPER=dcraw_emu
  # default args already target dcraw_emu: -w -W -o 1 -q 0 -T -Z {out} {in}

  # …or RawTherapee-cli with a neutral profile:
  export SHOOTS_RAW_DEVELOPER=rawtherapee-cli
  export SHOOTS_RAW_DEVELOPER_ARGS='-Y -q -o {out} -p neutral.pp3 -c {in}'
  ```

  `{in}` / `{out}` are substituted per file; the render goes to a temp dir. Only
  RAW files are re-rendered (rendered formats use their own pixels); CLIP stays on
  the embedded preview (it is colour-invariant). The provisioned LibRaw is
  cross-built and mirrored by the `libraw-mirror` CI workflow (see
  `scripts/prepare-libraw-mirror.ts`); until that mirror is published, set
  `SHOOTS_RAW_DEVELOPER` to a local binary.

The chosen strategy is recorded in the dataset and profile. Note: for proprietary
RAW (CR3/NEF/ARW) the embedded preview is the camera JPEG — edit-independent, so no
target leak; DNG with updated previews can leak and should be checked.
