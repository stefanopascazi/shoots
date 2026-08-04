# Develop predictor — reference baseline

> Internal engineering note, deliberately outside `docs/` — that directory is
> mirrored to the public site by `scripts/sync-webapp-content.mjs`, and these are
> one photographer's catalog figures, not user documentation.

Regenerated whenever the feature vector or the fit changes. **Compare against
this file, never against numbers quoted in an older run.** Three separate
conclusions were drawn against stale baselines before this file existed — a
random split, a half-sized dataset, and a run taken before the session-block
leak was closed (ca0532d) — and all three were wrong. A figure is only a
baseline for the model that produced it.

## Provenance

| | |
|---|---|
| commit | `c21fdad` |
| dataset | `train_v2.jsonl` — 2421 records, 553 edited (428 colour + 125 B&W) |
| baseline render | `external` (neutral, external RAW developer) |
| colour features | 50 |
| fold policy | whole sessions held out (`--group-by folder`) |
| **boldness** | **1** (`--boldness 1`) |

**The boldness matters more than anything else here.** At the default of 0 this
same fit gates 76 of 77 colour parameters and scores 0.0137 / 0.0132; at 1 it
gates 21 and scores 0.0759 / 0.0342. Numbers from the two are not comparable, and
nothing in this file applies to a profile trained without the flag.

Skill is `1 - MAE_model / MAE_constant` on photographs from shoots the fit never
saw. **±fold is the spread between held-out folds: a difference smaller than it
is not a difference.** Several parameters below carry ±20% or more — on a few
hundred images that is normal, and it is why single-parameter movements of two
or three points mean nothing on their own.

## Headline

| | colour | B&W |
|---|---:|---:|
| images / shoots | 428 / 32 | 125 / 32 |
| image-dependent skill | 0.0759 | 0.0328 |
| … with random folds | 0.1487 | 0.0687 |
| within-shoot skill | 0.0342 | −0.0021 |
| constant (both heads gated) | 21/77 | 24/41 |

The gap between grouped and random folds is session leakage, not a second result.
**Read `within-shoot`, not the headline** — a model that only reproduces per-shoot
averages scores fine on the headline and is useless in Lightroom.

## Anchored sliders — what actually ships for these

These do **not** come from the two heads. They are fitted as a correction toward
a target, `ȳ + gain·max(0, gap − d) + gainBelow·min(0, gap + d)`, with the gain
unshrunk. See `train/anchor.ts`.

| slider | anchor | gain above | gain below | dead zone | tail skill | mean skill |
|---|---|---:|---:|---:|---:|---:|
| `Dehaze` | detailCoarse | −102.3 | +256.1 | 0 | **0.258** | 0.258 |
| `Exposure2012` | lumaMean (log2) | −1.41 | +0.08 | 0.514 | **0.216** | 0.124 |
| `Highlights2012` | lumaP99 | −32.7 | −86.5 | 0 | **0.165** | 0.139 |
| `Whites2012` | clipHigh | +177.3 | −2366.3 | 0 | 0.120 | 0.281 |
| `Vibrance` | satStd | −22.5 | −45.4 | 0 | 0.077 | 0.032 |
| `Texture` | detailFine | +169.4 | +6356.5 | 0.012 | 0.024 | 0.024 |

B&W keeps one: `Dehaze` on `darkChannel`, tail 0.227.

**Tail skill is over the worst fifth of frames** — the ones carrying the largest
corrections, and the only place a preset and a prediction visibly differ. It is
what selects an anchor; mean skill only has to clear the frame head's error
allowance, because an unshrunk gain always costs average MAE.

`Exposure2012` reads as a rule: ±0.51 stops of do-nothing, then −1.41 stops per
stop of excess above it and +0.08 below. This photographer pulls overexposure
back hard and leaves underexposure alone.

### Trap: the per-parameter tables below do not describe these

For an anchored slider the table reports the **heads'** held-out skill, which is
not what inference uses — the anchor replaces both heads. `Dehaze` reads −0.5% in
the colour table and ships at 0.258; `Texture` and `Vibrance` read 0.0% and ship
at 0.024 and 0.077. Read the anchor table above for those six, and the tables
below for everything else.

## Predicted spread against the photographer's own

The number that says whether it is a preset or a prediction. Colour branch,
predicted over all 2421 records against the 553 real edits.

| slider | predicted sd | true sd | predicted range | true range |
|---|---:|---:|---|---|
| `Exposure2012` | 0.30 | 0.58 | [−1.5, 0.5] | [−3.5, 2.4] |
| `Highlights2012` | 17.3 | 33.0 | [−68.5, 0.7] | [−100, 41] |
| `Whites2012` | 6.2 | 24.0 | [−9.6, 66.2] | [−100, 61] |
| `Vibrance` | 2.4 | 8.4 | [2.7, 19.0] | [−20, 23] |
| `Texture` | 2.1 | 8.2 | [−11.2, 9.8] | [−26, 100] |
| `Dehaze` | 1.5 | 6.4 | [−5.2, 1.3] | [−22, 61] |
| `Clarity2012` | 1.1 | 7.5 | [−0.5, 5.4] | [−20, 56] |
| `Saturation` | **0.00** | 11.2 | constant | [−35, 14] |

Everything sits at a quarter to a half of the photographer's own spread. That is
the honest state: the model moves now, and not yet as far as they do.

`Saturation` is the one that stays a constant, and its own data supports it — it
tracks neither `satMean` nor `satStd` (−0.03 pooled, −0.005 within a shoot).
Whatever drives it is not the scene's colour.

## Colour branch — the parameters that carry anything

77 parameters, 21 constant. Only the non-zero rows are listed; the remaining ~50
sit at 0.0% (HSL, colour grading, split toning, parametric curve).

| parameter | end-end | ±fold | random | shoot | in-shoot | reach |
|---|---:|---:|---:|---:|---:|---:|
| `Contrast2012` | 20.7% | ±15.6% | 40.1% | 20.5% | −0.9% | 8.00 |
| `Highlights2012` | 19.8% | ±14.2% | 27.5% | 15.3% | **6.7%** | 1.03 |
| `Exposure2012` | 13.8% | ±5.2% | 19.9% | 2.9% | **9.3%** | 8.00 |
| `Shadows2012` | 9.1% | ±13.7% | 17.4% | 9.2% | −0.5% | 8.00 |
| `ToneCurvePoint0` | 5.6% | ±30.0% | 12.0% | 5.6% | 0.0% | 0.00 |
| `RedSaturation` | 5.6% | ±22.4% | 12.3% | 5.6% | 0.0% | 0.00 |
| `ToneCurvePoint64` | 4.0% | ±12.9% | 11.7% | 3.9% | −4.3% | 0.06 |
| `ToneCurvePoint96` | 4.0% | ±19.6% | 19.2% | 3.9% | −2.3% | 0.03 |
| `ToneCurvePoint32` | 3.7% | ±13.0% | 8.1% | 3.5% | −3.8% | 2.83 |
| `Temperature` | 3.3% | ±24.9% | 20.3% | 0.0% | **13.0%** | 0.78 |
| `Whites2012` | 3.1% | ±7.6% | 4.9% | 0.0% | 0.4% | 0.51 |
| `Blacks2012` | 1.8% | ±1.9% | 6.3% | 1.0% | 1.2% | 0.55 |
| `HueAdjustmentRed` | 1.5% | ±20.7% | 0.6% | 1.5% | 0.0% | 0.00 |

Worst rows, for the record: `SaturationAdjustmentMagenta` −6.5%, `RedHue` −3.3%,
`GreenHue` −2.2%, `BlueSaturation` −1.8%. All within their own ±fold.

`Exposure2012` and `Temperature` are the only two with real in-shoot skill
(9.3% and 13.0%) — they tell two frames of the same wedding apart. `Contrast2012`
has the highest headline and −0.9% in-shoot: it is a per-shoot level and nothing
more.

## B&W branch

41 parameters, 24 constant.

| parameter | end-end | ±fold | random | shoot | in-shoot | reach |
|---|---:|---:|---:|---:|---:|---:|
| `ToneCurvePoint96` | 18.2% | ±10.5% | 40.6% | 18.2% | −0.0% | 0.00 |
| `ToneCurvePoint64` | 16.7% | ±22.4% | 46.9% | 16.7% | 0.0% | 0.00 |
| `ToneCurvePoint32` | 14.9% | ±24.1% | 51.9% | 14.9% | 0.0% | 0.00 |
| `Dehaze` | 13.2% | ±15.4% | 26.7% | 13.2% | 0.0% | 0.00 |
| `GrayMixerMagenta` | 6.6% | ±10.1% | 30.5% | 6.4% | −3.0% | 0.02 |
| `Contrast2012` | 6.2% | ±8.6% | 13.0% | 6.2% | 0.0% | 0.00 |
| `GrayMixerYellow` | 5.9% | ±11.3% | 28.3% | 5.8% | −1.0% | 0.01 |
| `GrayMixerPurple` | 5.8% | ±9.6% | 27.1% | 5.7% | −1.1% | 0.01 |
| `GrayMixerRed` | 5.4% | ±8.7% | 25.9% | 5.1% | −2.6% | 0.02 |
| `Tint` | 4.8% | ±6.0% | 14.0% | 4.5% | −0.3% | 8.00 |
| `Exposure2012` | 4.3% | ±6.9% | 9.7% | 3.6% | −1.3% | 8.00 |
| `GrayMixerAqua` | 4.0% | ±6.8% | 17.2% | 4.0% | 0.0% | 0.00 |
| `Whites2012` | 3.9% | ±7.9% | 3.9% | 3.9% | 0.0% | 0.00 |
| `GrayMixerOrange` | 3.7% | ±6.5% | 18.5% | 3.5% | −1.8% | 0.02 |
| `GrayMixerBlue` | 2.8% | ±6.6% | 15.3% | 2.7% | −0.7% | 0.01 |

Within-shoot skill is −0.0021: on 125 images the B&W branch predicts a per-shoot
level and nothing per-frame. The `GrayMixer*` family, which scored 25–34% in the
previous baseline, now reads 3–7% — that earlier run was scored before the level
and frame heads were separated, so the two figures answer different questions.

## How to use this

1. Change one thing.
2. Re-run `develop train` on the **same** `train_v2.jsonl`, **with
   `--boldness 1`** — or re-export in full if the feature vector changed. A
   partial export silently starves the session context and invalidates every
   comparison.
3. Diff against the tables above, discounting anything inside ±fold.
4. For the six anchored sliders, diff the anchor table and the predicted-spread
   table instead: their rows in the per-parameter tables describe machinery that
   no longer decides their output.
5. Regenerate this file when the change lands.
