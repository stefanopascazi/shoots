# Road to 1.0 — plan of record

> Internal engineering note, deliberately outside `docs/` — that directory is
> mirrored to the public site by `scripts/sync-webapp-content.mjs`.
>
> Written 2026-08-24 against `0.7.3`. Companion to
> `packages/cli/src/develop/BASELINE.md` (the numbers to beat) and
> `packages/cli/src/develop/ENCODER-PLAN.md` (where tracks A1, A2, D and E come
> from). This file supersedes neither: it says what ships for 1.0 and in what
> order.
>
> Updated 2026-08-24: A1 and A2 measured and closed as nulls, A4 shipped. Two of
> the three 1.0 promises are now enforced in code rather than asserted here.

## What 1.0 promises

1.0 is a **stability commitment**, not a feature milestone. It says three
things, and nothing more:

- **The contract is frozen.** Flags, `--json` keys and exit codes do not change
  without a major. A profile trained on 1.0 keeps working across 1.x.
- **Every parameter states its own evidence.** *Shipped in A4* — every parameter
  is `predicted`, `leveled` or `constant`, recorded on the profile and reported by
  `develop train`, `develop status` and `develop predict --json`. Abstention is a
  first-class answer, not a failure.
- **Nothing shipped has negative held-out skill.** *Enforced since A4* — the
  trainer forces any such parameter to the photographer's constant, whatever the
  gate threshold says. On the reference catalog that is 17 colour parameters and
  2 B&W ones.

## What 1.0 does not promise

**Matching the photographer's own spread.** `BASELINE.md` measures predicted sd
at a quarter to a half of true sd on every slider. That is shrinkage under
uncertainty, and a calibrated model *must* under-disperse; reaching the
photographer's sd would mean overconfidence, not skill. Phase 2.5 and 2.6 in
`ENCODER-PLAN.md` closed this independently — `Contrast2012` is a per-shoot
level (−0.9% in-shoot) and inter-retoucher agreement on it is r≈0.07, so no
volume of data lifts it.

The 0.6.0 migration note ("the in-shoot spread remains below a photographer's
own, and closing that gap is the single biggest problem left") and the matching
line in `docs/roadmap.md` are therefore **retired by this plan**, replaced by
the three promises above.

---

## Work order

```
CLOSED         A1  EV estimator into the frame head      GATE FAILED — reverted
CLOSED         A2  tempMeasured anchor                   GATE FAILED — rejected
CLOSED         A4  drop negative-skill parameters        GATE MET — shipped
now, week      A3  B&W branch restructure                gate: in-shoot > −0.0021
               └─► A3 is the only item left needing the schema bump

now, parallel  C   collect 30 shoots × 10 photographers  long lead — starts first
now, days      B1  remove --xmp
then, week     B2  profile migration instead of refusal  gate: a v9 profile loads on v10
then, days     B3  freeze the --json contract
then, days     B4  version the pipeline file
then, days     B5  reconcile docs/roadmap.md + migrations

then, week     D   regenerate the pairs dataset          gate: Phase 2 ev/mired > 0.369/0.361
conditional    E   the encoder                           gated on D
```

Track A is the only one with a **hard deadline**: every change to the delta
space or the feature vector must land inside the pre-1.0 schema window. After
the freeze each one costs a major.

**Both delta-space changes have now closed as nulls** (A1 and A2, 2026-08-24).
That is a better outcome than it sounds: the deadline existed because changes to
the delta space are majors after the freeze, and there are none left wanting to
land. What remains of Track A is A3, which changes the B&W parameter set and so
still needs one bump, and A4, which needs no schema change at all. The pressure
on the window has largely gone, and 1.0 is closer, not further.

---

# Track A — the schema window

A1 and A2 both closed as nulls without touching the schema. A4 shipped without
touching it either. **A3 is the only item left in the window**, and it is the
only reason a `SCHEMA_VERSION` bump (9 → 10) and a forced retrain are still on
the table for 0.8.0.

It needs no re-export. The migration is `Required: yes / Affects: profile` — not
`dataset`.

## A1 — the EV estimator scalar into the frame head · CLOSED 2026-08-24 · **reverted**

Built, measured, reverted. Full write-up is Phase 2.7 in `ENCODER-PLAN.md`; the
short version:

| | colour in-shoot | `Exposure2012` in-shoot |
|---|---:|---:|
| control (column masked off, reproduces `BASELINE.md`) | 0.0342 | **9.3%** |
| prior added to the four tone columns | 0.0347 | **9.6%** |
| prior replacing the four tone columns | 0.0260 | **3.5%** |

`Exposure2012` carries ±5.2% between folds, so +0.3 is not a movement. The
domain-gap suspicion was checked and cleared: the estimate read off the export's
render correlates at 0.986 with the one read off the pairs render.

**Why Phase 2.5's +5.5% did not survive contact.** It was measured against a
*gated* frame head — against no per-frame modulation at all. The shipped head is
not gated for `Exposure2012`; it has four hand-picked tone columns already
extracting 9.3%. A feature is decided by its incremental contribution, and that
question was never asked. The third row above is the answer when it is: a
projection of 50 columns fitted on 18k synthetic degradations is a *worse*
summary of a frame's exposure state than four columns fitted on the
photographer's own edits.

**What was kept.** `tools/export-estimator` and its `evEstimator.json` — the
artifact is the record, and any encoder Phase 3 produces is now scored against
*this ridge* rather than against nothing. Nothing shipped changed:
`SCHEMA_VERSION` stays at 9 and no retrain is forced.

**What this changes downstream.**

- **Track A is now three items, not four**, and the schema window is
  correspondingly cheaper — A2 alone would not have justified a forced retrain,
  which is exactly the trade Phase 0 flagged. It still needs A3 or A4 to travel
  with it.
- **Track E's premise is materially weaker.** Its bet was down to one slider
  after Phase 2.5; that slider's estimator has now been built and is dominated by
  columns the tool already has. A stronger estimator of the same quantity has to
  beat 9.3%, not 0%.
- **The rule that generalises**, now written into the file: a skill number
  measured against a constant is not a reason to add a feature to a model already
  beating that constant. Every future candidate is measured incrementally against
  what ships.

## A2 — `tempMeasured` as the Temperature anchor · CLOSED 2026-08-24 · **rejected**

Measured with `tools/wb-anchor`, which reproduces Phase 0's table (A 874 K,
B 469 K, C 453 K) and then asks what Phase 0 did not: is the gain spread across
shoots, or carried by a few?

| | |
|---|---|
| pooled gain of `tempMeasured` over `tempAsShot` | 15 K (skill 0.033), against B's own ±11.9 shuffle spread |
| shoots it improves | **12 / 28** |
| per-shoot margin | median **−13 K**, worst −245 K, best +452 K |

One shoot carries it: `2026-04-25`, n=59, where the two references disagree most.

**The mechanism.** What decides a reference is not how close it sits to the
chosen Kelvin but how *steady* an offset it needs — a gated parameter emits one
scalar per shoot, so the within-shoot spread of `log(chosen / ref)` is the whole
story. `tempAsShot` is **exact in 8 shoots of 28** (spread zero: one ratio
explains the entire shoot) because the photographer's chosen Kelvin is a fixed
ratio of the dial they set. `tempMeasured` re-meters frame by frame and destroys
all 8, while on 207 of 553 frames the two values are identical anyway.

**Rejected.** `Temperature` keeps `ref: 'asShotTemp'`, `SCHEMA_VERSION` stays 9.
15 K of pooled MAE from one shoot is not worth invalidating every trained
profile. Full write-up sits under Phase 0 in `ENCODER-PLAN.md`; `tools/wb-anchor`
reproduces it in one command.

**The same error as A1, in a different disguise.** A1's baseline was wrong; A2's
*aggregation* was wrong — a pooled mean over shoots of wildly different size,
reported without the per-shoot column Phase 2.5 had already shown to be the
load-bearing one. Both notes recorded a real number; neither recorded the number
that decides anything.

## A3 — restructure the B&W branch

41 parameters over 125 images and 32 shoots is not undertrained, it is
**unidentifiable**. `BASELINE.md` reads within-shoot −0.0021: the branch emits a
per-shoot level and nothing else. No plausible dataset fixes a 41-parameter fit
at n=125, so this is a modelling decision, not a data problem.

### Steps

1. Derive the tonal parameters (`Exposure2012`, `Contrast2012`, `Whites2012`,
   `Blacks2012`, curve knots) from the colour branch's own decisions rather than
   fitting them again on 125 frames.
2. Replace the `GrayMixer*` family (8 parameters, all 2.8–6.6% headline with
   0 to −3% in-shoot) with a fixed per-profile policy plus **one** learned
   per-shoot scalar.
3. Keep `Dehaze` on `darkChannel` — the one anchored B&W slider that works
   (tail 0.227).

Target: ~5 free parameters, down from 41.

### Gate

- B&W within-shoot skill > −0.0021 (i.e. no longer negative), and
- B&W headline skill ≥ 0.0328 — the restructure must not buy per-frame movement
  by giving up the level it already predicts correctly.

### Tests

- `packages/cli/test/unit/` — new suite for the derivation: a colour decision
  vector maps to the B&W tonal set deterministically; the `GrayMixer` policy is
  a pure function of the profile; `Dehaze` still routes through the anchor path.
- `packages/cli/test/unit/anchor.test.ts` — extend, if the anchor selection code
  changes shape.

## A4 — stop shipping parameters with negative skill · CLOSED 2026-08-24 · **shipped**

Done. Promise 3 is now enforced by the trainer rather than asserted in this file.

### What shipped

A floor the `--boldness` knob cannot lower. The existing gate asks whether a
parameter's skill is clear of its own noise, which is a judgement call and is
what boldness moves. This asks a different question the knob has no business
answering: **is the model worse than the photographer's own average?** A negative
end-to-end held-out skill says exactly that, and shipping it means paying
accuracy for the privilege of making a prediction.

It runs after the end-to-end pass that produces the number and after the anchors,
because an anchored slider does not predict through the heads — its row in the
end-to-end table describes machinery inference does not use. `Dehaze` reads
−0.5% there and ships at 0.258 tail skill; gating on that row would silence a
slider that works.

A forced parameter has both heads gated, response 1, and its reported numbers
rewritten to what it now emits (`modelMae = baselineMae`, skill 0) — leaving the
error of a model that no longer runs would report a regression the profile cannot
produce.

### The three states, now stated rather than inferred

`packages/cli/src/develop/develop/paramState.ts`. Every parameter is
`predicted`, `leveled` or `constant`, recorded on the profile and surfaced in
three places: the `develop train` report, `develop status`, and
`develop predict --json` (a `parameters` map per branch, plus a line on stderr).
`gateReason` gained `negative-skill` alongside `low-skill` and `degenerate`.

An anchored slider reports `predicted` whatever its heads did — the anchor
replaces both, and reading the heads' gates is how `Dehaze` comes back labelled a
constant.

### Gate — met

`train_v2.jsonl`, whole sessions held out, both boldness settings:

| | colour | B&W |
|---|---|---|
| parameters forced to constant | **17** | **2** |
| negative-skill rows still shipping (boldness 1) | 0 | 0 |
| negative-skill rows still shipping (boldness 0) | 0 | 0 |

The colour branch forces `Tint`, `RedHue`, `GreenHue`, `GreenSaturation`,
`BlueHue`, `BlueSaturation`, `PostCropVignetteAmount`, `GrainAmount`,
`ToneCurvePoint224`, `SaturationAdjustmentGreen`, `SaturationAdjustmentMagenta`,
`ColorGradeMidtoneHue`, `ColorGradeMidtoneSat` and the four split-toning
parameters. B&W forces `Blacks2012` and `ToneCurvePoint128`.

The one row left negative is `Dehaze` at −0.5%, which is anchored and therefore
excluded by design.

### What it did not do, and that is the point

The headline barely moved: 0.0759 / 0.0342 before and after. The 17 forced
parameters carry **2.07%** of the weighted baseline MAE between them — they were
small contributors that happened to be wrong, not a hidden reserve of skill.
Nothing here was ever going to raise a score. What changed is that the profile
stopped making 19 predictions it measurably could not support.

The colour branch now reports 38/77 constant rather than 21/77. That is the
honest number, and it is the first time the profile's own report says how many
sliders it declines to move.

### Schema

None. A4 adds fields to the profile and changes no stored layout, so
`SCHEMA_VERSION` stays at 9 and no retrain is forced — a profile trained before
this simply reports no `state` and has it reconstructed from the gates it does
carry.

## A — combined migration

One entry in `packages/cli/src/release-notes/migrations.ts`:

> **0.8.0 — Retrain: a black-and-white branch that fits its own evidence**
> **Required:** yes · **Affects:** profile

A4 needs no entry of its own: it adds fields and changes no stored layout, so an
old profile keeps working and simply reports fewer details.

Must state: no re-export is needed (`develop train` alone is enough); the
feedback journal survives; `develop calibrate` must be re-run because the
offsets were measured against a model that no longer exists.

`npm run docs:migrations` regenerates `docs/migrations.md`; `preversion` already
gates on `--check`.

## A — regenerate the baseline

`BASELINE.md` is regenerated **once**, after A3 lands, from a single
`develop train --boldness 1 --group-by folder` run on the unchanged
`train_v2.jsonl`. Its own rule applies: a figure is only a baseline for the
model that produced it, so no intermediate table is written.

---

# Track B — freeze the contract

## B1 — remove `--xmp`

Deprecated in 0.7.0 with a warning and hidden from `--help`
(`packages/cli/src/commands/develop.ts:182`). Remove the option, the
both-passed error branch, and the warning. Last window before the freeze.

**Tests:** a CLI test asserting `--xmp` is rejected with a message naming
`--sidecars`.

## B2 — migrate profiles instead of refusing them

The blocker behind promise 1. Today a schema bump makes `develop predict` refuse
a stored profile outright: 0.5.0 and 0.6.0 both shipped
`Required: yes / Affects: profile, dataset`. A tool that invalidates the user's
trained profile on a minor cannot claim a stable 1.x.

### Steps

1. Version-tag the stored profile (already carries `SCHEMA_VERSION`).
2. Add a migration chain: `v9 → v10` and forward, each step a pure function on
   the stored profile.
3. Where a mechanical migration is impossible (A1 adds a column no v9 profile
   has weights for), migrate to a **degraded but valid** profile — the new
   column zeroed, which is exactly "as if the prior gated" — and warn that a
   retrain recovers the win. Refusal becomes the last resort, not the default.
4. From 1.0: a minor may add a migration step, never a refusal.

**Gate:** a profile trained on v9 loads on v10, predicts, and its predictions
match the v9 profile's on every parameter the migration did not touch.

**Tests:** a v9 profile fixture is checked in; the suite asserts it loads,
migrates, predicts, and that the untouched parameters are bit-identical.

## B3 — freeze the `--json` contract

"Scriptable before interactive" is a design goal, but no command has ever
declared its output stable.

1. Snapshot every command's `--json` shape as a test fixture.
2. Document the guarantee: keys may be **added** in a minor, never removed or
   retyped.
3. Fix what is wrong now, while it is still free.

**Tests:** one snapshot test per command that speaks `--json`.

## B4 — version the pipeline file

`docs/roadmap.md` says the pipeline surface "may still gain steps — there are no
conditionals yet". Add a `version:` key to the pipeline file and a validator
that rejects a file from the future with a readable message. Conditionals can
then land in a minor as an additive step, after 1.0, without a second format.

**Tests:** extend `pipelineInitPrompt` / `pipelineInitWizard` suites — a
scaffolded file carries the version; an unknown version fails with a message
naming the tool version needed.

## B5 — reconcile the documentation

- `docs/roadmap.md`: rewrite **Next** around the three promises. Delete "closing
  that gap is the single biggest problem left" — this plan retires it. State the
  three-state per-parameter contract as the shipped behaviour.
- `docs/develop-predictor.md`: document `predicted` / `leveled` / `constant`.
- Re-run `npm run docs:migrations`.

---

# Track C — data: many small catalogs

**Start this first. It is the only item with a lead time measured in months.**

`ENCODER-PLAN.md` Phase 2.6 found the largest measured opportunity left in the
project, and found nothing that reaches it:

| slider | per-shoot ceiling | best predictor found |
|---|---:|---:|
| `Dehaze` | 56.9% | 11.8% (CLIP, K chosen after seeing the results — not a result) |
| `Exposure2012` | 32.0% | 1.7% |
| `Highlights2012` | 5.1% | 0.3% |

Every attempt stalls on **21 shoots**. The external catalog has 113 shoots but a
median of 4 frames each, so only a fifth qualify.

> Ten photographers giving 30 shoots each answers this. One photographer giving
> 10,000 more frames does not.

This reframes the ask, and it is the reframing that makes it affordable. Phase 5
assumed the Aftershoot/Imagen model — 2,500–5,000 edited images per photographer
under licence, which is slow, expensive and legal. What the measurements
actually demand is **~30 shoots from ~10 people**: a favour among colleagues,
not a contract.

### Steps

1. Define the ask precisely: 30 shoots, ≥ 8 edited frames each, XMP sidecars
   only — **no images leave the photographer's machine.** `develop export` can
   already produce the feature/target records locally; only the derived vectors
   need to travel.
2. Write the one-page ask and the consent text. This is a commercial/legal
   artefact, not an engineering one.
3. Ship an `export --contribute` path that produces exactly that bundle and
   nothing more, so the privacy claim is verifiable by reading one function.
4. Re-run `tools/shoot-gain` at n ≈ 300 shoots. That is the measurement the
   whole per-shoot-gain question is waiting on.

### The free compounding path, in parallel

The tool is a personal-profile tool: every user is their own dataset, and
`develop feedback` already exists. Every edit made after a prediction is a free
labelled pair, on the user's own machine, violating no design goal. Confirm the
journal captures enough to be used as training rows, and make the loop explicit
in the docs.

### Explicitly out

FiveK, PPR10K and INRetouch are all non-commercial, and PPR10K extends the ban
to derived data. `raw.pixls.us` is CC0 and is the sensor-diversity fallback for
Track D — not an edit dataset.

---

# Track D — regenerate the pairs dataset

`tools/photometric-pairs` exists: 37,955 samples over 7,591 sources, 1.8 GB.
Phase 2 measured that today's features recover `ev` 0.369 and `mired` 0.361 —
so **63% and 64% remain on the table**. Four known fixes, all specified in
`ENCODER-PLAN.md` Phase 1:

1. **Cap the positive EV sample against the reference's own headroom.** 70% of
   the 5,151 badly clipped variants (median +1.51 EV) are caused by the push
   itself. Above 20% clipping the EV label is half a stop out.
2. **Widen `--tint` to ≈ ±60.** At ±20 the tint perturbation is **15.9× smaller**
   in channel gain than `--mired` at ±60, so the 0.060 tint score measures the
   generator, not the features. Do not conclude anything about tint until this
   is re-run.
3. **Add contrast and black-lift degradations** — a power curve around a 0.18
   pivot in linear, and an additive linear offset (veiling flare, physically
   real). Without them the encoder attributes contrast variance to exposure
   error.
4. **Add direct targets** (no perturbation, computed from the linear reference):
   highlight headroom, shadow occupancy, dynamic range. This is the `lumaP99`
   family — the one hand-rolled feature that demonstrably worked.

Stays out: HSL, split toning, colour grading, vibrance, clarity, grain,
vignette. Recovering a synthetic saturation boost says nothing about the
saturation a photograph wants, and `BASELINE.md` has every one of them gated
with negative skill.

**Gate:** re-run `tools/label-recovery`. `ev` > 0.369 and `mired` > 0.361 on
held-out scenes, or the regeneration bought nothing.

**Known limitation to carry forward:** the archive is 99.8% Canon (12 NEF).
Self-cancelling for a personal model since every label is a delta against that
file's own as-shot render. If sensor bias surfaces, `raw.pixls.us` (CC0, roughly
one file per camera model) is the fix.

---

# Track E — the encoder (conditional)

**Do not start this before A1 has a number and D has re-run.** Phase 2.5
downgraded the bet in its own words: *"the bet is no longer 'the corrective half
of editing'. It is one slider."* Weeks of CNN work for per-frame exposure is a
bad trade while a linear ridge on existing features delivers +5.5% in days.

Constraints, both already established: ONNX-exportable and CPU-only
(`onnxruntime-node`, MIT, +24 MB, validated); training data commercially clean,
which is why the dataset is self-supervised in the first place.

**The negative to keep in view.** Pooled WB correlation is 0.520 and worth
nothing: only 11 of 24 shoots agree on the sign, and in several the photographer
never moved `Temperature` inside a shoot at all. The per-frame variance being
predicted **does not exist**. No encoder creates it. "White balance is the
predictable part" is true *across* photographers (FiveK, r≈0.6–0.7) and false
*within* this one's shoots.

**Gate to enter:** D lifts Phase 2 label recovery. **Gate to ship:**
`Exposure2012`, `Highlights2012` and `Temperature` improve *within-shoot* skill
against the regenerated `BASELINE.md` — headline movement does not count.

---

# Test strategy

Every track carries unit tests per the project convention, but the tracks are
not tested the same way, and conflating the two is how the previous rounds of
this work ended without a conclusion.

**Deterministic code — unit tests.** Tracks A2, A4, B1–B5, and the loaders and
masks of A1/A3. Pure functions, fixtures, exact assertions. These run in
`npm run test:unit` and gate CI like everything else.

**Model changes — measurement against `BASELINE.md`.** A1, A3, D, E. The unit
tests prove the code does what it says; only a held-out run says whether it
helps. The rules are already written at the foot of `BASELINE.md` and they are
binding here:

1. Change one thing.
2. Re-run on the **same** `train_v2.jsonl`, with `--boldness 1` and
   `--group-by folder`.
3. Discount anything inside ±fold. Several parameters carry ±20% or more.
4. Read **within-shoot**, not the headline.
5. Regenerate `BASELINE.md` when the change lands — once, at the end of Track A.

**A gate that fails is a result, not a setback.** This is not hypothetical any
more: A1 returned +0.3 against ±5.2, was reverted the same day, and the number
now lives in `ENCODER-PLAN.md` as Phase 2.7. It cost one day and took the
strongest unmeasured claim in the project off the table.

Two rules came out of A1 and A2, and between them they would have caught both
before either was started:

1. **Measure incrementally against what ships, never against a constant.** A1's
   +5.5% was real and irrelevant, because its baseline was a gated head the model
   does not use.
2. **Report the per-shoot breakdown, never a pooled mean alone.** A2's 15 K was
   real and came from one shoot out of 28. Phase 2.5 had already established that
   the sign-agreement column beats the pooled figure; A2's note predates that
   lesson and was never revisited against it.

Both failures share a shape: a number that was true, recorded without the
comparison that makes it actionable. A recorded result now carries its baseline
and its per-shoot spread, or it is not a result.

**Platform coverage** is handled outside CI: the owner runs the suite on Windows
and Linux personally. `ci.yml` stays ubuntu-only by decision, not omission.

---

# Release sequencing

**0.8.0 — the schema window.** A3 and B1 (A4 is already in). One migration,
`Required: yes / Affects: profile`. The last release that may break a profile.

**0.9.0 — the contract.** B2, B3, B4, B5. After this, a profile survives a minor
and the JSON shape is fixed. Track D lands here or in a 0.9.x; Track C is
running throughout.

**1.0.0 — the freeze.** No new behaviour. The release exists to say: from here,
`Required: yes` does not appear in a migration note again without a major.

Track E, and every editor adapter after `rapidraw` (darktable, RawTherapee, ON1,
Capture One), are post-1.0 by design. The adapter interface already isolates
them, so each is additive.

## The one real risk

Track C. If it does not start now, the per-shoot ceilings — 32% on `Exposure2012`,
57% on `Dehaze`, the largest measured opportunity in the project — are still
unreachable in six months, and no amount of engineering substitutes for it.
