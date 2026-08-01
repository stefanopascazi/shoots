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
| commit | `200935c` |
| dataset | `train_v2.jsonl` — 2422 records, 553 edited |
| baseline render | `external` (neutral, external RAW developer) |
| colour features | 50 |
| fold policy | whole sessions held out (`--group-by folder`) |
| gate | skill ≤ 0.02 → the photographer's constant |

Skill is `1 - MAE_model / MAE_constant` on photographs from shoots the fit never
saw. **±fold is the spread between held-out folds: a difference smaller than it
is not a difference.** Several parameters below carry ±25% or more — on a few
hundred images that is normal, and it is why single-parameter movements of two
or three points mean nothing on their own.

## Colour branch

77 parameters, 70 gated.

| parameter | skill | ±fold | λ | state |
|---|---:|---:|---:|---|
| `Contrast2012` | 23.8% | ±27.3% | 100 | **predicted** |
| `Highlights2012` | 14.0% | ±10.2% | 1000 | **predicted** |
| `Exposure2012` | 10.2% | ±3.9% | 300 | **predicted** |
| `ToneCurvePoint96` | 5.0% | ±7.4% | 30000 | **predicted** |
| `Blacks2012` | 4.7% | ±4.7% | 100 | **predicted** |
| `ToneCurvePoint32` | 3.4% | ±29.3% | 3000 | **predicted** |
| `Texture` | 2.2% | ±20.3% | 10000 | **predicted** |
| `ToneCurvePoint64` | 1.7% | ±20.0% | 10000 | gated → constant |
| `Dehaze` | 1.0% | ±11.8% | 10000 | gated → constant |
| `ToneCurvePoint224` | 0.1% | ±6.5% | 30000 | gated → constant |
| `ParametricHighlights` | 0.0% | ±0.0% | 30000 | never moves |
| `ParametricLights` | 0.0% | ±0.0% | 30000 | never moves |
| `ParametricDarks` | 0.0% | ±0.0% | 30000 | never moves |
| `ParametricShadows` | 0.0% | ±0.0% | 30000 | never moves |
| `ShadowTint` | 0.0% | ±0.0% | 30000 | never moves |
| `HueAdjustmentPurple` | 0.0% | ±0.0% | 30000 | never moves |
| `HueAdjustmentMagenta` | 0.0% | ±0.0% | 30000 | never moves |
| `LuminanceAdjustmentPurple` | 0.0% | ±0.0% | 30000 | never moves |
| `LuminanceAdjustmentMagenta` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeShadowHue` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeShadowSat` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeShadowLum` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeMidtoneLum` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeHighlightHue` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeHighlightSat` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeHighlightLum` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeGlobalHue` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeGlobalSat` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeGlobalLum` | 0.0% | ±0.0% | 30000 | never moves |
| `ColorGradeBlending` | 0.0% | ±0.0% | 30000 | never moves |
| `SplitToningBalance` | 0.0% | ±0.0% | 30000 | never moves |
| `ToneCurvePoint128` | -0.0% | ±9.3% | 30000 | gated → constant |
| `ToneCurvePoint255` | -0.2% | ±39.6% | 3000 | gated → constant |
| `GreenSaturation` | -0.7% | ±5.5% | 30000 | gated → constant |
| `Vibrance` | -1.0% | ±10.2% | 3000 | gated → constant |
| `SaturationAdjustmentGreen` | -1.0% | ±10.8% | 30000 | gated → constant |
| `ToneCurvePoint192` | -1.2% | ±2.9% | 30000 | gated → constant |
| `SaturationAdjustmentPurple` | -1.4% | ±9.4% | 30000 | gated → constant |
| `HueAdjustmentBlue` | -1.6% | ±6.2% | 30000 | gated → constant |
| `LuminanceAdjustmentGreen` | -1.6% | ±7.1% | 30000 | gated → constant |
| `HueAdjustmentGreen` | -1.6% | ±7.9% | 30000 | gated → constant |
| `LuminanceAdjustmentYellow` | -1.8% | ±9.7% | 30000 | gated → constant |
| `ColorGradeMidtoneHue` | -1.8% | ±5.9% | 30000 | gated → constant |
| `HueAdjustmentAqua` | -1.8% | ±18.7% | 30000 | gated → constant |
| `Temperature` | -2.1% | ±8.6% | 30000 | gated → constant |
| `LuminanceAdjustmentBlue` | -2.3% | ±25.9% | 30000 | gated → constant |
| `RedHue` | -2.4% | ±17.1% | 30000 | gated → constant |
| `GrainAmount` | -2.4% | ±9.8% | 30000 | gated → constant |
| `LuminanceAdjustmentAqua` | -2.4% | ±10.7% | 30000 | gated → constant |
| `BlueHue` | -2.4% | ±10.0% | 30000 | gated → constant |
| `GreenHue` | -2.5% | ±89.9% | 30000 | gated → constant |
| `ColorGradeMidtoneSat` | -2.5% | ±11.2% | 30000 | gated → constant |
| `Shadows2012` | -2.8% | ±25.9% | 10000 | gated → constant |
| `ToneCurvePoint0` | -2.9% | ±27.9% | 3000 | gated → constant |
| `LuminanceAdjustmentOrange` | -3.0% | ±7.4% | 30000 | gated → constant |
| `Whites2012` | -3.0% | ±16.7% | 10000 | gated → constant |
| `ToneCurvePoint160` | -3.4% | ±22.8% | 30000 | gated → constant |
| `HueAdjustmentOrange` | -3.4% | ±16.3% | 30000 | gated → constant |
| `SaturationAdjustmentMagenta` | -3.5% | ±12.2% | 30000 | gated → constant |
| `LuminanceAdjustmentRed` | -3.5% | ±11.4% | 30000 | gated → constant |
| `HueAdjustmentRed` | -3.7% | ±9.5% | 30000 | gated → constant |
| `BlueSaturation` | -4.0% | ±16.9% | 30000 | gated → constant |
| `SaturationAdjustmentBlue` | -4.1% | ±14.8% | 30000 | gated → constant |
| `SaturationAdjustmentRed` | -4.5% | ±15.8% | 30000 | gated → constant |
| `SaturationAdjustmentOrange` | -5.2% | ±14.4% | 30000 | gated → constant |
| `RedSaturation` | -5.2% | ±30.2% | 10000 | gated → constant |
| `Clarity2012` | -5.6% | ±22.4% | 30000 | gated → constant |
| `SplitToningHighlightHue` | -5.7% | ±12.7% | 30000 | gated → constant |
| `HueAdjustmentYellow` | -7.4% | ±18.4% | 30000 | gated → constant |
| `SaturationAdjustmentAqua` | -7.5% | ±2.1% | 30000 | gated → constant |
| `SaturationAdjustmentYellow` | -7.9% | ±101.5% | 30000 | gated → constant |
| `PostCropVignetteAmount` | -15.1% | ±58.9% | 30000 | gated → constant |
| `SplitToningShadowHue` | -16.3% | ±62.2% | 30000 | gated → constant |
| `SplitToningShadowSaturation` | -17.4% | ±71.4% | 30000 | gated → constant |
| `SplitToningHighlightSaturation` | -19.1% | ±79.0% | 30000 | gated → constant |
| `Saturation` | -24.3% | ±83.2% | 30000 | gated → constant |
| `Tint` | -27.7% | ±71.1% | 10000 | gated → constant |

## Black & white branch

41 parameters, 24 gated.

| parameter | skill | ±fold | λ | state |
|---|---:|---:|---:|---|
| `GrayMixerMagenta` | 33.6% | ±4.3% | 100 | **predicted** |
| `GrayMixerRed` | 33.2% | ±4.1% | 100 | **predicted** |
| `GrayMixerPurple` | 31.7% | ±6.3% | 100 | **predicted** |
| `GrayMixerYellow` | 29.2% | ±4.3% | 100 | **predicted** |
| `GrayMixerOrange` | 26.5% | ±6.1% | 100 | **predicted** |
| `GrayMixerBlue` | 25.2% | ±16.0% | 100 | **predicted** |
| `Dehaze` | 24.2% | ±16.3% | 100 | **predicted** |
| `Contrast2012` | 17.7% | ±12.4% | 100 | **predicted** |
| `ToneCurvePoint224` | 12.5% | ±9.8% | 100 | **predicted** |
| `GrayMixerAqua` | 12.4% | ±15.6% | 100 | **predicted** |
| `Tint` | 11.7% | ±12.1% | 100 | **predicted** |
| `ToneCurvePoint192` | 10.4% | ±8.2% | 100 | **predicted** |
| `ToneCurvePoint160` | 9.8% | ±16.6% | 100 | **predicted** |
| `GrayMixerGreen` | 9.3% | ±15.6% | 100 | **predicted** |
| `Blacks2012` | 7.9% | ±7.3% | 100 | **predicted** |
| `Texture` | 4.7% | ±6.0% | 100 | **predicted** |
| `ToneCurvePoint255` | 3.0% | ±8.6% | 100 | **predicted** |
| `Whites2012` | 0.6% | ±4.3% | 300 | gated → constant |
| `Shadows2012` | 0.6% | ±4.3% | 1000 | gated → constant |
| `PostCropVignetteAmount` | 0.4% | ±3.2% | 3000 | gated → constant |
| `ParametricHighlights` | 0.0% | ±0.0% | 30000 | never moves |
| `ParametricLights` | 0.0% | ±0.0% | 30000 | never moves |
| `ParametricDarks` | 0.0% | ±0.0% | 30000 | never moves |
| `ParametricShadows` | 0.0% | ±0.0% | 30000 | never moves |
| `ShadowTint` | 0.0% | ±0.0% | 30000 | never moves |
| `RedHue` | 0.0% | ±0.0% | 30000 | never moves |
| `RedSaturation` | 0.0% | ±0.0% | 30000 | never moves |
| `GreenHue` | 0.0% | ±0.0% | 30000 | never moves |
| `GreenSaturation` | 0.0% | ±0.0% | 30000 | never moves |
| `BlueHue` | 0.0% | ±0.0% | 30000 | never moves |
| `BlueSaturation` | 0.0% | ±0.0% | 30000 | never moves |
| `ToneCurvePoint0` | -0.6% | ±1.5% | 100 | gated → constant |
| `Exposure2012` | -0.7% | ±10.0% | 300 | gated → constant |
| `GrainAmount` | -0.8% | ±1.8% | 30000 | gated → constant |
| `Clarity2012` | -1.6% | ±2.4% | 30000 | gated → constant |
| `ToneCurvePoint128` | -1.7% | ±5.9% | 1000 | gated → constant |
| `Highlights2012` | -2.2% | ±1.4% | 30000 | gated → constant |
| `ToneCurvePoint32` | -4.3% | ±6.5% | 100 | gated → constant |
| `ToneCurvePoint64` | -8.3% | ±12.2% | 10000 | gated → constant |
| `ToneCurvePoint96` | -8.7% | ±10.0% | 30000 | gated → constant |
| `Temperature` | -9.2% | ±11.6% | 30000 | gated → constant |

## How to use this

1. Change one thing.
2. Re-run `develop train` on the **same** `train_v2.jsonl` — or re-export in
   full if the feature vector changed. A partial export silently starves the
   session context and invalidates every comparison.
3. Diff against the table above, discounting anything inside ±fold.
4. Regenerate this file when the change lands.
