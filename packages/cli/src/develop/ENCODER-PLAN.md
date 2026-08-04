# Photometric encoder — plan of record

> Internal engineering note, deliberately outside `docs/` (that directory is
> mirrored to the public site by `scripts/sync-webapp-content.mjs`).
>
> Updated 2026-08-03. Compare against `BASELINE.md` for the numbers this is
> trying to move.

## The problem this addresses

The develop predictor's bottleneck is its **input**, not its regressor.

- CLIP is trained to be *invariant* to exposure, white balance and contrast —
  the exact quantities the tone sliders depend on.
- The 50 hand-rolled photometric features only partly cover the gap. `lumaP99`
  works (Highlights +9.6); `lumaP01`, detail and haze do not.
- `Temperature` scores −2.1% and gates out on the reference catalog, while
  inter-retoucher agreement on FiveK makes white balance the single **most**
  image-driven parameter there is (r≈0.6–0.7, against 0.07 for Contrast).
- The learning curve is flat across n = 40/80/160/320. More data on the same
  representation does not help. That is what points at the representation.

## What is deliberately not the goal

Teaching taste. Nothing in this plan ever sees a photographer's choice. It
teaches the **corrective** half of editing — where the exposure and the white
point should sit — which FiveK says is the half that is predictable from the
image at all. The taste half stays the photographer's constant, and improving it
needs first-party catalogs (below), not a better encoder.

---

## Phase 0 — the as-shot WB prior · CLOSED 2026-08-03 · **already shipped**

**The premise was wrong, and the win is already banked.** `Temperature` is
declared `{ transform: 'logK', ref: 'asShotTemp' }` in `develop/schema.ts`, so
its delta is `log(chosen) − log(asShot)` and a gated parameter already emits
`asShotKelvin × exp(mean log ratio)` — which *is* "as-shot plus one learned
offset".

The 0.42–0.47 in the earlier experiment note measures that anchor against a
**global constant Kelvin**, a baseline the shipped model never uses. Re-measured
on `train_v2.jsonl`, 553 edited frames, whole sessions held out over 48 shoots:

| anchor | held-out MAE |
|---|---|
| A — global constant Kelvin | 860 K |
| B — as-shot × learned offset **(ships today)** | 471 K |
| C — `tempMeasured` × learned offset | 449 K |

`skill(B vs A) = 0.452` — that is the number in the note, and it was never an
available lever. `Temperature`'s −2.1% in `BASELINE.md` is the *ridge* failing to
beat this prior, which is why it gates; the prior itself is doing its job.

**The one remaining lever**, and it is small: switching the anchor from
`tempAsShot` (the WB dial) to `tempMeasured` (what the body metered from the
light) is worth **+3.7% ± 2.3%**, winning 11 of 12 fold reshuffles — 22 K of MAE.
It is a one-line change in `refValue`, but it redefines the Temperature delta
space and so needs a `SCHEMA_VERSION` bump that invalidates every trained
profile. **Not worth forcing a retrain on its own; bundle it with the next schema
change.**

*Lesson for this file: the note said "the as-shot prior beats ridge 2x" and that
was read as an unimplemented lever for three rounds. A recorded skill number
without its baseline stated is not actionable.*

## Phase 1 — the dataset · BUILT 2026-08-03 · `test/datapairs`

`tools/photometric-pairs` over the NAS archive. **7591 sources of 7594** (3
failed), **37,955 samples**, 1.8 GB at 512px, no degenerate frames. 4682 CR3 +
2897 CR2 + 12 NEF across ~10 bodies. Edited or not — no XMP is ever read.

Labels are uniform, symmetric and exact wherever the scene has headroom: median
EV error 0.039 and white-balance ratio error 0.2%, which is the *measurement's*
own floor (JPEG quantisation), not label error.

### Clipping is the one real defect, and it is quantified

| clip | share | median EV err | median R/B err |
|---|---|---|---|
| <0.5% | 68.8% | 0.039 | 0.2% |
| 0.5–2% | 8.5% | 0.031 | 0.9% |
| 2–5% | 7.3% | 0.061 | 4.4% |
| 5–20% | 11.1% | 0.131 | 8.9% |
| >20% | 4.3% | **0.514** | **22.3%** |

Above 20% the EV label is half a stop out: the image no longer contains what the
label claims. Of the 5151 variants above 5% clipping, **70% are caused by the
positive EV push** (median +1.51 EV) and would be recovered by capping the
exposure sample against the reference's own headroom; 29% are already blown in
the reference, where no sampling scheme helps — the worst is a white sheet
against a white sky at 62.6%, which is the photograph, not a bug.

**Decision: regenerate before Phase 3, not before Phase 2.** Dropping
`clip > 5%` left 25,213 usable samples, ample for Phase 2 — which has now run and
said the encoder is worth building. The regeneration should therefore happen
alongside Phase 3, carrying two fixes:

1. **cap the positive EV against the reference's headroom** — recovers the 70% of
   badly clipped variants that the push caused;
2. **widen `--tint`** — at ±20 the tint perturbation is 15.9x smaller in channel
   gain than `--mired` at ±60, which is why Phase 2 could not measure it. Roughly
   ±60 tint would put the two on comparable footing.

**Known limitation:** the set is **99.8% Canon** (12 NEF). Irrelevant for a
personal model, and largely self-cancelling even for a shared one since every
label is a delta against that file's own as-shot render. If sensor bias does
surface, the fix is raw.pixls.us (CC0, ~one file per camera model — sensor
diversity, which is exactly what this archive lacks).

**Still to add**, both free because they stay per-channel LUTs:

- **contrast** — power curve around a 0.18 pivot, in linear
- **black lift** — additive offset in linear (veiling flare; physically real)

Not for their own sake: without them the encoder attributes contrast variance to
exposure error, because a flat scene and a contrasty one with the same mean are
indistinguishable to a model that can only estimate a mean.

**Also to add, as direct targets rather than degradations** (computed from the
linear reference, no perturbation): highlight headroom, shadow occupancy,
dynamic range. This is the `lumaP99` family — the one hand-rolled feature that
demonstrably worked.

**Explicitly out:** HSL, split toning, colour grading, vibrance, clarity, grain,
vignette. They can be applied and recovered, but recovering a synthetic
saturation boost says nothing about the saturation a photograph *wants* — there
is no anchor, and `BASELINE.md` already has every one of them gated with
negative skill.

## Phase 2 — the kill-switch experiment · RUN 2026-08-03 · **encoder not falsified**

`tools/label-recovery`. Ridge from the existing 50 photometric features to the
synthetic labels; 25,213 samples over 7503 scenes (`clip ≤ 0.05`, variant 0
excluded); folds hold out whole source scenes; λ re-selected inside every outer
fold over a grid extended down to 1e-4.

| label | skill | ±shuffle | baseline MAE |
|---|---|---|---|
| `ev` | **0.369** | 0.0001 | 0.915 stops |
| `mired` | **0.361** | 0.0005 | 29.7 mired |
| `tint` | 0.060 | 0.0002 | 10.0 |

**The middle answer, which is the informative one.** The features carry about a
third of the exposure and white-balance error and miss the other two-thirds. So:

- the encoder is **not** falsified — there is 63% of `ev` and 64% of `mired` it
  could still take, and that is now the number Phase 3 has to beat;
- neither are the hand features useless, which rules out throwing them away.

λ selects the bottom of the grid on every label: with n=25k against 50 columns
the ridge is not overfitting at all, so the shortfall is missing information, not
shrinkage. Including variant 0 drops every score (0.277 / 0.241 / 0.009) because
a fifth of the set then sits on the label (0,0,0), where the mean baseline is
already exact — the table above is the cleaner read.

**Do not read the `tint` row as "tint is unrecoverable".** At full range the
`mired` perturbation spans a 1.837 channel-gain spread against `tint`'s 1.053 —
**15.9x larger**. The tint range was sampled far too narrow relative to natural
scene variation, so 0.060 measures the generator, not the features. Widen
`--tint` on the regeneration below and re-run before drawing any conclusion.

## Phase 2.5 — the missing link · RUN 2026-08-04 · **scope collapsed to one slider**

`tools/missing-link`. Phase 2 tested link 1 of three; this tests link 3 — does the
estimate an encoder would produce actually predict what the photographer did?

Every edited catalog frame is also in the pairs dataset, so its variant 0 has
features from the identical pipeline (no domain gap). The synthetic estimator is
fitted with all 48 catalog scenes withheld, then applied to those frames.

Asked *within* a shoot, because asked globally it answers the wrong question and
answers it confusingly: pooled WB correlation is 0.50 while pooled held-out skill
is 0.00. Same reason the shipped model has two heads — a global linear map spends
itself on session offsets. The baseline is therefore "no per-frame modulation",
i.e. exactly what a gated frame head emits.

| parameter | r within | shoots agreeing on sign | skill within shoot |
|---|---|---|---|
| **`Exposure2012`** | **−0.464** | **22/24** | **+0.0553 ± 0.0035** |
| `Highlights2012` | −0.222 | 14/24 | +0.0022 ± 0.0056 |
| `Shadows2012` | 0.063 | 10/24 | −0.0061 |
| `Contrast2012` | 0.121 | 12/24 | −0.0403 |
| `WB (mired)` | 0.520 | **11/24** | −0.0067 ± 0.0192 |

**Exposure is the only parameter where the link holds** — and it holds hard: 22
shoots of 24 agree on the sign. Everything else sits at chance agreement with
zero or negative skill.

**The WB row is the important negative.** A pooled 0.520 looks like the strongest
number in the table and is worth nothing: only 11 of 24 shoots agree on the sign,
and in several the photographer never moved `Temperature` within the shoot at all
— the per-frame variance being predicted does not exist. No encoder fixes that.
It also closes the premise this plan inherited from the FiveK ceiling analysis:
"white balance is the predictable part" is true *across* photographers and false
*within* this one's shoots, where it is set once and left.

**Consequence for Phase 3: the bet is no longer "the corrective half of editing".
It is one slider.** Weeks of encoder work to improve per-frame exposure is a much
worse trade than this plan assumed when it was written.

**Do this first — days, not weeks.** The +5.5% is already available from a linear
ridge on features the tool computes today. Feed that one scalar into the frame
head for `Exposure2012` and diff against `BASELINE.md` (currently 10.2% ± 3.9%).
It is a real product change, it is cheap, and it converts the encoder question
from "is there any signal" into "is a stronger estimator worth it" — answerable
against a number instead of a hope.

## Phase 2.6 — the per-shoot gain · RUN 2026-08-04 · **ceiling found, not reachable**

`tools/shoot-gain`. An anchored slider's intensity is a property of the *shoot*,
not of the photographer: fitted inside each shoot separately the gain runs from
−4.23 to +0.34 where the global fit says −1.01. `--anchor-gain` exists because
one number cannot serve both habits.

Measured on a second, independent catalog — 1265 edited frames over 113 shoots,
against the reference catalog's 553 over 48. Leave-one-shoot-out, descriptors
taken from frames disjoint from the gain fit:

| slider | shoots | ceiling | best photometric | best CLIP |
|---|---:|---:|---:|---:|
| `Dehaze` | 19–25 | **56.9%** | 2.8% | 11.8% (K=3) |
| `Exposure2012` | 15–21 | **32.0%** | −1.2% | 1.7% |
| `Highlights2012` | 13 | 5.1% | 0.3% | — |
| `Whites2012` | 11 | 4.5% | 0.5% | — |

**The ceilings are the largest measured opportunity left in this project** — 32%
of the error on the frames that need exposure correction, 57% on dehaze — and
they are per-shoot, not per-frame.

**Nothing reaches them.** Five shoot-level photometric descriptors correlate at
best −0.33 and lose to the global gain when actually used. The reference catalog
agreed independently: ceiling 29.3%, predictor −8.6%.

`Dehaze` at 11.8% from three CLIP components is the one hint, and it is **not a
result**: K was chosen after seeing all four values, on 25 shoots. Redo it with
nested selection of K before building anything on it.

**Conclusion for `--anchor-gain`: calibrate it once by eye and stop.** Two
catalogs, four sliders, photometric and semantic descriptors all fail. The
intensity is irreducibly the photographer's.

**Conclusion for data collection, and it is the important one.** What is missing
is not frames, it is *shoots*. The unexploited structure lives between shoots and
21 of them is what stalls every test here — the external catalog has 113 shoots
but a median of 4 frames each, so only a fifth qualify. Ten photographers giving
30 shoots each would answer this; one photographer giving 10,000 more frames
would not. That reframes [[Phase 5]]: ask for *many small catalogs*, not few
large ones.

## Phase 3 — train the encoder · weeks · gated on Phase 2.5

A small CNN or fine-tuned compact backbone over the degraded image, predicting
the degradation vector plus a low-dimensional embedding.

Hard constraints, both already established:

- **ONNX-exportable**, CPU-only. `onnxruntime-node` (MIT) embeds in the Bun
  single binary — validated, +24MB.
- **Commercially clean training data.** This is why the dataset is
  self-supervised in the first place: every public RAW→edit dataset (FiveK,
  PPR10K, INRetouch) is non-commercial, and PPR10K extends the ban to derived
  data.

**Gate:** beats the Phase 2 ridge on held-out label recovery.

**Known risk, and the check for it:** the encoder learns distance from *as-shot*,
and as-shot is not "correct" — the camera's metering and AWB carry their own
error. So a perfect score on synthetic labels does not guarantee the feature is
useful on real edits. The check is Phase 4, not more synthetic validation.

## Phase 4 — plug it into the predictor · gated on Phase 3

Replace or augment the colour feature block with the encoder's output, retrain,
diff against `BASELINE.md` discounting anything inside ±fold.

**Gate:** `Temperature`, `Highlights`, `Exposure` improve within-shoot skill.
Read `withinSessionSkill`, not the headline — a model that only reproduces
per-shoot averages scores fine on the headline.

## Phase 5 — first-party catalogs · NOT STARTED · long lead, start early

The one thing no amount of engineering substitutes for. Aftershoot and Imagen
require **2,500 minimum / 5,000 recommended edited images per photographer**;
their "Talent AI Profiles" are licensed catalogs of named photographers. The
owner has 553. That is 5x short even for a personal profile, before any shared
base exists.

Options: user opt-in in the ToS, or paying a handful of photographers for a
catalog licence. Ten wedding photographers × 3,000 images ≈ FiveK scale with
today's parameter vocabulary (FiveK is entirely PV2003 — `Brightness`,
`HighlightRecovery`, zero `Exposure2012`).

This is a commercial action, not an engineering one, and it is on the critical
path. It should be started in parallel with Phase 1, not after Phase 4.

---

## Order of work

```
Phase 0 ──────────────► ship (independent of everything below)
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
Phase 5 ──────────────────────────────────► (parallel, long lead)
```

Phase 2 is the branch point. Everything after it is conditional on a measurement
that has not been taken yet, and pretending otherwise is how the previous rounds
of this work ended without a conclusion.

## Falsified — do not retry

- Hand-rolled photometric priors as target anchors (median-luma → Exposure,
  clipHigh → Highlights, clipShadow → Shadows). Skill went **negative**:
  Exposure −1.1, Shadows −0.9, Blacks −0.8.
- Raw 512-dim CLIP embeddings as features at n≈500. p≫n; costs more than
  dropping them (colour skill 0.019 raw against 0.046 dropped, losing 12 fold
  shuffles out of 12).
- Replacing ridge with a higher-variance regressor on the *same* features. λ
  already sits at 30000 across most of the colour branch — the fit is saying
  "zero the weights". More variance widens the gate, it does not close it.
