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

## Phase 0 — the as-shot WB prior · NOT STARTED · ~1 day

**Do this before anything else.** Measured 2026-08-01: `Temperature` anchored on
the camera's as-shot Kelvin plus one learned offset scores **0.42–0.47 skill at
n=40**, roughly double the full ridge (0.17–0.25) at every training size. It is
still not in the model, and today `Temperature` ships gated at −2.1%.

It needs no encoder, no new data and no licence review. It is the only item on
this list with a payoff that has already been measured rather than hoped for, and
it gives a visible win in Lightroom while the long work runs.

**Gate:** `Temperature` un-gates in `BASELINE.md`. If it does not, the anchoring
is wrong and the rest of this plan's premise about white balance needs re-reading.

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

**Decision: do not regenerate yet.** Dropping `clip > 5%` leaves **32,800 clean
samples**, which is ample for Phase 2 — and Phase 2 decides whether an encoder is
worth building at all. If it says yes, regenerate with the headroom cap *while*
the encoder is built, as parallel work rather than a blocking re-run.

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

## Phase 2 — the kill-switch experiment · ~1 day · DO BEFORE BUILDING ANYTHING

**Fit a ridge from the existing 50 photometric features to the synthetic labels.**

The task is well posed and non-trivial: from the degraded image alone, say how
far it is from as-shot. Mean luminance cannot do it — a genuinely dark scene at
0 EV and a bright scene at −2 EV have the same mean — so success requires a prior
over what correct photographs look like.

- **If the 50 features already recover ΔEV and Δmired held-out across scenes:**
  the representation is *not* the bottleneck for these quantities, and the
  encoder is falsified for a day's work instead of a month's. Stop; the ceiling
  is elsewhere.
- **If they cannot:** the gap is measured, in the same units the encoder will be
  scored in, and Phase 3 has a number to beat.

This is the cheapest decisive experiment available and it must not be skipped
because the encoder is the more interesting thing to build.

## Phase 3 — train the encoder · weeks · gated on Phase 2

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
