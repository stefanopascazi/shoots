# Road to 1.0 — plan of record

> Internal engineering note, deliberately outside `docs/` — that directory is
> mirrored to the public site by `scripts/sync-webapp-content.mjs`.
>
> Written 2026-08-24 against `0.7.3`. Companion to
> `packages/cli/src/develop/BASELINE.md` (the numbers to beat) and
> `packages/cli/src/develop/ENCODER-PLAN.md` (where tracks A1, D and E come
> from). This file supersedes neither: it says what ships for 1.0 and in what
> order.

## What 1.0 promises

1.0 is a **stability commitment**, not a feature milestone. It says three
things, and nothing more:

- **The contract is frozen.** Flags, `--json` keys and exit codes do not change
  without a major. A profile trained on 1.0 keeps working across 1.x.
- **Every parameter states its own evidence.** A prediction says whether it is
  per-frame, per-shoot, or abstained — and abstention is a first-class answer,
  not a failure.
- **Nothing shipped has negative held-out skill.** Today four colour parameters
  do (`SaturationAdjustmentMagenta` −6.5%, `RedHue` −3.3%, `GreenHue` −2.2%,
  `BlueSaturation` −1.8%).

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
now, days      A1  EV estimator into the frame head      gate: Exposure2012 in-shoot > 9.3%
now, days      A2  tempMeasured anchor                   gate: Temperature MAE −22 K
now, week      A3  B&W branch restructure                gate: in-shoot > −0.0021
now, days      A4  drop negative-skill parameters        gate: no shipped param < 0
               └─► ONE SCHEMA_VERSION 9→10, one migration, one retrain

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

---

# Track A — the schema window

All four land in **one** `SCHEMA_VERSION` bump (9 → 10), one migration entry,
one `develop train`. Shipping them separately would force three retrains for
one benefit.

**None of them needs a re-export.** Verified against `train_v2.jsonl`:
`features` is the stored 50-wide colour vector (A1 derives from it), and
`asShot.tempMeasured` is present on 2421 of 2422 records (A2 reads it). The
migration is therefore `Required: yes / Affects: profile` — not `dataset`.

## A1 — the EV estimator scalar into the frame head

**The measured, banked, unspent win.** `ENCODER-PLAN.md` Phase 2.5:
`+0.0553 ± 0.0035` within-shoot skill on `Exposure2012`, with **22 of 24 shoots
agreeing on the sign**. It comes from a linear ridge on features the tool
already computes. Phase 2.5 says "do this first — days, not weeks"; it was run
2026-08-04 and no commit has touched the develop model since.

### Why it is not redundant with the columns already there

`Exposure2012`'s frame mask allows four colour columns
(`lumaMedian`, `lumaMean`, `shadowFloor`, `lumaP99`). The EV estimator is a
projection of **all 50**, with coefficients fitted on 25,213 synthetic samples
instead of 553 catalog frames. It is transfer learning through a frozen linear
map: information the n=553 ridge could never afford to fit, delivered as one
column.

### Steps

1. **Export the estimator.** Extend `tools/label-recovery` (or add
   `tools/export-estimator`) to emit the fitted `ev` ridge as JSON:
   `{ mean[50], std[50], w[50], bias, yspread, ybar, featureNames[50], provenance }`.
   `fitRidge` in `tools/lib/fit.ts:38` carries its own standardization, so all
   of it must travel — a bare weight vector is unusable.
   - Training set: `pairs.jsonl`, `variant !== 0`, `clip <= 0.05`, λ = 0.3.
   - Pin `featureNames` and assert against `COLOR_FEATURE_NAMES` at load: if the
     colour block ever reorders, the estimator must fail loudly, not silently
     read the wrong columns.

2. **Check the JSON into the package** — `packages/cli/src/develop/develop/evEstimator.json`
   plus a loader in `evEstimator.ts` exposing `estimateEv(colour: number[]): number`.
   ~150 numbers; no model download, no new dependency, works offline.

3. **Add the block to the feature layout.** `packages/cli/src/develop/develop/assemble.ts`:
   `baseFeatures` becomes `[ embedding | colour | prior | asShot ]` with
   `PRIOR_DIM = 1`. Add `prior: number` to `FeatureLayout`
   (`develop/featureSets.ts:36`) and thread it through `frameWidth`,
   `levelWidth`, `frameMask`, `levelMask`, and every construction site of a
   layout in `train/train.ts`.

4. **Gate the block by parameter, not globally.** In `PARAM_SETS`, only
   `Exposure2012` gets `prior: true` initially. The measurement covers exactly
   one slider; `Highlights2012` reads +0.0022 ± 0.0056 and everything else is at
   or below chance. Opening it wider is a second experiment, not this one.

5. **Bump `SCHEMA_VERSION` to 10** (`develop/schema.ts:219`) — once, for all of
   Track A.

### Gate

`develop train --data train_v2.jsonl --boldness 1 --group-by folder`, diffed
against `BASELINE.md`:

- **`Exposure2012` in-shoot > 9.3%** and outside the ±fold spread. Phase 2.5
  predicts roughly 9.3 → 14–15%.
- Colour headline within-shoot skill ≥ 0.0342 (no regression elsewhere).
- If in-shoot does not move outside ±fold: **revert the block, do not tune it.**
  A null here also kills Track E, and that is a useful answer.

### Tests

- `packages/cli/test/unit/evEstimator.test.ts` — new. Loader validates the JSON
  shape; `estimateEv` reproduces a known `predict()` output from a small fixture
  (fit a 3-feature ridge in the test, round-trip it through the JSON format,
  assert equality to 1e-9); a `featureNames` mismatch throws.
- `packages/cli/test/unit/featureAssembly.test.ts` — extend. `baseFeatures`
  width is `embedding + 50 + 1 + AS_SHOT_DIM`; the prior column sits at the
  documented index; `deviationFrom` subtracts it like any other column.
- `packages/cli/test/unit/labelSets.test.ts` — extend. `frameMask` opens the
  prior column for `Exposure2012` and closes it for every other parameter;
  `frameWidth`/`levelWidth` account for it.

## A2 — `tempMeasured` as the Temperature anchor

`ENCODER-PLAN.md` Phase 0: **+3.7% ± 2.3%**, winning 11 of 12 fold reshuffles,
22 K of held-out MAE (471 K → 449 K). One line, but it redefines the Temperature
delta space — which is exactly why it waits for a schema bump it can share.

### Steps

1. `develop/schema.ts:38` — add `'measuredTemp'` to `DeltaRef`.
2. `refValue` (`schema.ts:302`) — `case 'measuredTemp': return meta.tempMeasured ?? meta.tempAsShot ?? 5500`.
   The double fallback matters: `tempMeasured` comes from EXIF
   `ColorTempMeasured` (`adapters/acr/ingest.ts:200`) and a body that does not
   report it must degrade to today's behaviour, not to 5500 K.
3. `schema.ts:125` — `Temperature` switches `ref: 'asShotTemp'` → `'measuredTemp'`.

### Gate

Held-out Temperature MAE ≤ 452 K on `train_v2.jsonl` (from 471 K), whole
sessions held out. Report the share of records lacking `tempMeasured` alongside
it: on a catalog where that share is high the win shrinks toward zero, and the
number must not be read as a regression.

### Tests

- `packages/cli/test/unit/developSchema.test.ts` — extend. `encodeDelta` /
  `decodeDelta` round-trip for `Temperature` against `tempMeasured`; the
  fallback chain resolves `tempMeasured → tempAsShot → 5500` in order; a
  `measuredTemp` param with both fields null encodes delta 0 at 5500 K.

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

## A4 — stop shipping parameters with negative skill

Four colour parameters ship today with negative held-out skill
(`SaturationAdjustmentMagenta` −6.5%, `RedHue` −3.3%, `GreenHue` −2.2%,
`BlueSaturation` −1.8%). All four sit inside their own ±fold, so the honest
reading is "no signal" rather than "actively harmful" — but shipping a
prediction that cannot beat the constant contradicts promise 3.

### Steps

1. In the evaluation pass (`train/evaluate.ts`), record each parameter's final
   state as one of `predicted` (frame head survives the gate), `leveled` (level
   head only) or `constant` (both gated).
2. Force `constant` when held-out skill ≤ 0, regardless of gate threshold.
3. Store the three-state map in the profile and surface it: `develop status`
   lists it, `develop predict --json` reports it per parameter, and a human-
   readable line says how many sliders were moved and how many abstained.

This is also what makes promise 2 verifiable rather than rhetorical.

### Gate

No parameter in the shipped profile has negative held-out skill, on both
branches, at `--boldness 0` and `--boldness 1`.

### Tests

- `packages/cli/test/unit/evaluate.test.ts` — extend. A parameter with negative
  skill resolves to `constant`; one with frame-head skill above the gate
  resolves to `predicted`; one with level-only skill resolves to `leveled`.
- `packages/cli/test/unit/releaseNotes.test.ts` — unaffected, but the new
  migration entry needs its row (see B5).

## A — combined migration

One entry in `packages/cli/src/release-notes/migrations.ts`:

> **0.8.0 — Retrain: the exposure prior, a measured white point, and a B&W
> branch that fits**
> **Required:** yes · **Affects:** profile

Must state: no re-export is needed (`develop train` alone is enough); the
feedback journal survives; `develop calibrate` must be re-run because the
offsets were measured against a model that no longer exists.

`npm run docs:migrations` regenerates `docs/migrations.md`; `preversion` already
gates on `--check`.

## A — regenerate the baseline

`BASELINE.md` is regenerated **once**, after all four land, from a single
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

**A gate that fails is a result, not a setback.** A1 returning nothing outside
±fold kills Track E and saves weeks; that is the plan working. Revert, record
the number in `ENCODER-PLAN.md`, do not tune the block until it passes.

**Platform coverage** is handled outside CI: the owner runs the suite on Windows
and Linux personally. `ci.yml` stays ubuntu-only by decision, not omission.

---

# Release sequencing

**0.8.0 — the schema window.** Track A entire, plus B1. One migration,
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
