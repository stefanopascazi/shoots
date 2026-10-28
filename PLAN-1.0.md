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
> Updated 2026-08-24: Track A is closed. A1, A2 and A3 measured and not shipped;
> A4 shipped. Two of the three 1.0 promises are now enforced in code rather than
> asserted here, and 0.8.0 forces no retrain.
>
> Updated 2026-10-28: **strategy change — Lightroom Classic only until launch.**
> The section below supersedes Track B's scope, the editor sequencing and the
> release plan. Tracks A, C, D and E stand as written; C is now run through the
> plugin beta.

# Strategy change — 2026-10-28

The product is a **Lightroom Classic plugin** and a **local web app** it opens.
The CLI stays as the free engine behind both. Everything else is paused until
launch.

## Status — where to pick up (2026-10-28)

**Done** (all on `main`, pushed; release still `0.7.3`):

- [x] Strategy recorded here and in `docs/roadmap.md` (public via the site sync).
- [x] CLI: `cull` / `rate --files-from <list>` — explicit file list instead of a folder.
- [x] CLI: `SHOOTS_PROGRESS_FILE` — progress as JSON lines for a polling host.
- [x] L1 plugin skeleton, `plugins/lightroom/` — Cull Selection (blurry → rejected),
      Rate Selection (0–5 stars), written to the catalog as one undo step.
- [x] Plugin: install on first use (official installer), update when older than
      the plugin, `setup` for dependencies; menu items + Plug-in Manager buttons.
- [x] Plugin: progress bar driven by the progress file.
- [x] `npm run build:lrplugin` → `dist-plugin/shoots.lrplugin` + versioned zip.
- [x] Tests: pure Lua modules under fengari, part of `npm run test:unit`.

**Not verified yet:** anything inside a real Lightroom (SDK calls, Plug-in Manager
panel), and the installer launched by the plugin (needs a release carrying
`--files-from`).

**Next, in order:**

1. **Field test on the Lightroom PC.** Copy `dist-bin/shoots.exe` (from
   `npm run build:binary`) to `%USERPROFILE%\.shoots\bin\` and add
   `dist-plugin/shoots.lrplugin` in the Plug-in Manager. Check: both menu items,
   progress bar, undo, virtual copies, offline files, the panel buttons. Fix what
   breaks.
2. **Release `0.7.4`** (features, no migration note → patch) once the field test
   passes, so the plugin's own install/update path can be tested; add the plugin
   zip to `release.yml`.
3. **L1 leftovers**: write `rate` keywords into the catalog; decide whether cull
   should also flag keepers; cancel support (kill the child process).
4. **L2 catalog export** → training reads JSON, not sidecars.
5. **Track W** — local web app, started/stopped from the plugin.
6. **L3** apply predictions via `applyDevelopSettings`.
7. Remove the Ink shell, then XMP (only after 4 and 6).
8. Beta data program (Track C) — legal pack first.

## Decided

- **Remove the interactive shell (Ink).** Four files today (`shell/`,
  `shell/triage/`, `components/`, `pipeline/init`). The plugin replaces it as the
  front for non-technical users; every command it fronted stays on the CLI.
- **Pause every editor but Lightroom Classic.** `rapidraw` is frozen, not
  deleted: the adapter interface (`develop/adapters/types.ts`) stays, so other
  editors remain additive after launch.
- **Remove XMP and the sidecar path** — but **last**, not first. XMP/exiftool
  reach ~50 source files and training reads sidecars today. Order:
  1. the plugin exports develop settings from the catalog
     (`photo:getDevelopSettings()`) as JSON;
  2. training reads that export;
  3. predictions are applied through `photo:applyDevelopSettings()`, ratings,
     picks and labels through `photo:setRawMetadata()`;
  4. only then remove the sidecar writers, `--xmp` (was B1) and the `acr` XMP
     adapter.
- **Storage format.** JSON for small payloads, **JSONL** for datasets (what
  `train_v2.jsonl` already is). "JSONB" is a Postgres internal, not a file
  format; if a dataset outgrows JSONL, use **SQLite** (public domain).

## Track L — the Lightroom Classic plugin

Lua, Lightroom Classic SDK. Lightroom (cloud) has no comparable SDK and is out.

1. **Fast operations first** (*skeleton shipped*): `cull`, `rate`, picks and colour labels written
   into the catalog. Calls the binary via `LrTasks.execute`, passes the selection
   as a path list (`--files-from`), reports through `LrProgressScope`.
2. **Catalog export** for training (step 1 of the XMP removal above).
3. **Apply predictions** to the selection, as a named history step / snapshot so
   the user can return to the prior state.
4. **Open app / close app** menu items driving Track W.

The binary is installed by running the official `install.ps1` / `install.sh`
from the plugin (download, SHA-256 check, `~/.shoots/bin`). A download made
that way carries no Mark-of-the-Web / quarantine attribute, so it raises no
SmartScreen or Gatekeeper prompt. **Do not bundle
the binary inside a zipped `.lrplugin`**: a browser-downloaded zip propagates
the quarantine to its contents. Code signing becomes a trust and antivirus
question, not a blocker (see Open decisions).

## Track W — the local web app

Training, `calibrate --review` and review in the browser, on a local server.
The review server already exists and is the starting point.

- **The app cannot touch the catalog** — only the plugin can, inside Lightroom.
  Flow: plugin exports JSON → server trains/reviews → plugin reads the result
  and applies it.
- **Lifecycle**: "open app" starts the server and opens the browser
  (`LrHttp.openUrlInBrowser`); "close app" stops it. Add a heartbeat and an idle
  timeout so a Lightroom crash never leaves an orphan server.
- **Security**: bind `127.0.0.1` only, a per-session token, reject foreign
  `Host`/`Origin` headers (DNS rebinding).

## Track C, reframed — the beta data program

Accounts exist for analytics and for **beta testers only** to share derived
vectors (never images) with the project. After launch: back to fully local, with
an explicit, default-off "share data with shoots" opt-in in the plugin.

Must exist **before** the first byte is collected:

- privacy notice, explicit consent, named data controller, revocation and
  deletion (GDPR — treat CLIP embeddings and feature vectors as personal data);
- a data licence from each tester granting **commercial** use for training —
  otherwise the project's own licensing rule is broken by its own dataset;
- the bundle produced by one readable function (`export --contribute`), so the
  privacy claim is verifiable.

## What this does to 1.0

The contract worth freezing is now **plugin ↔ engine** (the JSON the plugin
sends and reads back), not CLI flags. B2 (profile migration) and B4 (pipeline
versioning) stand. B3 becomes "freeze the plugin ↔ engine JSON". B1 is absorbed
into the XMP removal. B5 is done by this update.

## Open decisions

- **Licence vs professional use.** PolyForm Noncommercial forbids commercial
  use, and a photographer editing for clients is commercial use — so the free
  CLI is, as licensed, unusable by the paying audience. Candidate model: CLI free
  for noncommercial use, plugin paid and carrying the commercial licence. Public
  copy ("free, no subscription") must follow whatever is chosen.
- **Code signing.** Not required for the plugin-download path above. Still worth
  pricing (Apple Developer ID + notarization; a Windows certificate) for
  antivirus heuristics and the credibility of a paid product.
- **exiftool after XMP.** `import`/`rename`/`exif` read metadata outside
  Lightroom; check whether exiftool is still needed there before removing it.
- **Competition inside Lightroom**: Adobe's own assisted culling, Excire,
  Aftershoot, Imagen. The differentiator to defend is a personal profile that
  never leaves the machine.

---

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
CLOSED         A3  B&W branch restructure                PREMISE FALSIFIED — not built
               └─► nothing left in Track A. No schema bump, no forced retrain.

next           B1  remove --xmp                          days
               B2  profile migration instead of refusal  gate: a v9 profile loads on v10
               B3  freeze the --json contract
               B4  version the pipeline file
               B5  reconcile docs/roadmap.md + migrations

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

**Track A is closed, and nothing in it changed the schema.** A1 and A2 measured
as nulls; A4 shipped as an additive change; A3's premise did not survive contact
with the data. `SCHEMA_VERSION` stays at 9, and **0.8.0 forces no retrain** —
the first release in three not to.

The window that dominated this plan turned out to have nothing wanting to pass
through it. That is worth stating plainly rather than quietly deleting: the
deadline was real, and the right response to it was to measure what wanted to
land, not to assume.

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

## A3 — restructure the B&W branch · CLOSED 2026-08-24 · **premise falsified, not built**

This section previously read: *"41 parameters over 125 images and 32 shoots is
not undertrained, it is **unidentifiable**"*, and proposed three fixes. All three
are wrong, and the first one is wrong about the code.

### 1. "41 parameters is unidentifiable" — false, and it was my own premise

The heads do not fit 41 parameters jointly. `train/regress.ts` builds the normal
equations **once** from the features (`xtx` depends on `X` alone) and then solves
each parameter as its own ridge row against its own right-hand side. Adding a
parameter costs one more back-substitution and **no degrees of freedom**. Every
one of the 41 is an independent n=125 regression.

So reducing 41 to 5 buys nothing. The count was never the problem, and the
sentence that said it was is the kind of claim that sounds like a measurement and
is not one.

### 2. "Derive the tonal parameters from the colour branch" — falsified by the data

Inside the 16 shoots that carry both treatments, the photographer does *not* give
the B&W frames the colour frames' tonal treatment:

| slider | mean difference (B&W − colour) | sd of that difference |
|---|---:|---:|
| `Shadows2012` | **−30.95** | 21.37 |
| `Highlights2012` | +16.28 | 31.04 |
| `Blacks2012` | −11.51 | 22.15 |
| `Whites2012` | −6.81 | 22.17 |
| `Contrast2012` | +2.16 | 6.00 |
| `Exposure2012` | +0.09 | 0.44 |

A B&W conversion is a different decision, not the colour edit plus an offset —
and the spread of the differences is as large as the differences, so it is not a
learnable constant either.

### 3. "Share the frame head across treatments" — the one idea worth testing, and it fails

Not in the original plan; it is what the falsification of (2) leaves standing.
The frame head does not predict the number, it predicts the **departure from this
shoot's own level**, which subtracts exactly the difference above. If "this frame
is a stop brighter than its neighbours" has one answer across both treatments,
the B&W frame head could be fitted on 553 photographs instead of 125.

`tools/bw-transfer` measures it: per shared parameter, scored on B&W frames only,
whole shoots held out, shrinkage re-selected inside every outer fold for each arm
separately.

| parameter | B&W only | + colour pooled | change | ±shuffle |
|---|---:|---:|---:|---:|
| `Highlights2012` | 3.3% | 3.1% | −0.2 | ±1.3 |
| `Tint` | −3.3% | 0.8% | +4.1 | ±0.3 |
| `Clarity2012` | −0.9% | −0.0% | +0.9 | ±0.0 |
| `Blacks2012` | −0.4% | 0.2% | +0.6 | ±0.3 |
| `Contrast2012` | −0.5% | −0.1% | +0.3 | ±0.0 |
| `Exposure2012` | −1.6% | −6.3% | **−4.7** | ±0.2 |
| `Whites2012` | −0.3% | −6.5% | **−6.2** | ±3.8 |

Every arm sits within a point or two of zero, which is what a properly shrunk fit
does when there is nothing to find: λ goes high and the prediction collapses to
the mean. Pooling costs more on `Exposure2012` and `Whites2012` than it buys
anywhere. **The B&W frame head has no per-frame signal, and colour evidence does
not supply one.**

### What the B&W branch actually is

Not broken. **Small.** 125 photographs over 32 shoots, of which **11 carry four
frames or more** — and a shoot of one or two frames poses no within-shoot
question at all, because a frame deviates from itself by nothing. The colour
branch has 428 over 32.

The level head works: `ToneCurvePoint96` 18.2%, `ToneCurvePoint64` 16.7%,
`Dehaze` 13.2%, headline 3.3%. What the branch predicts is a per-shoot level, and
a per-shoot level is what 11 shoots can support. Calling that "the weakest branch
by a wide margin" measured per-frame skill on a branch with a quarter of the data
and a third of the usable shoots.

**Fixing it needs shoots, which is Track C** — the constraint Phase 2.6 already
identified as binding for the per-shoot gains, arrived at here independently from
the other direction.

### What did come out of it

A real defect in the contract A4 shipped hours earlier. See below.

## A4 addendum — a response of zero is a constant

`predict.ts` computes `mean + response × (raw − mean)`, so a de-shrinking slope of
**zero returns the mean exactly as a gate does**. `clampResponse` produces exactly
zero whenever the measured slope came out at or below zero — held-out
anti-correlation, the fit reading noise — which is common.

A4's first cut read only the gate flag, so those parameters reported `predicted`
when they provably could not move. The correction is in `headEmitsConstant`, and
it changes the honest picture substantially:

| | before the fix | after |
|---|---|---|
| colour | 38 predicted / 1 leveled / 38 constant | **18 / 3 / 56** |
| B&W | 26 predicted / 2 leveled / 13 constant | **19 / 4 / 18** |

Half the colour branch's claimed predictions were parameters whose frame head had
been measured at a slope of zero.

## Decided — the frame-head floor stays out

A4 forces a parameter to a constant when its **end-to-end** skill is negative.
The same argument applies one level down, and the numbers are worse there:

| branch | frame head live on | of which negative shipped skill |
|---|---:|---:|
| colour | 14 / 77 | **9** |
| B&W | 17 / 41 | **15** |

A frame head's baseline *is* "no per-frame modulation", so a negative shipped
skill means that head is measurably worse than not running. Fifteen of B&W's
seventeen are in that state, which is the whole of why its within-shoot skill
reads −0.0021.

**Why this is not mine to decide.** At `--boldness 1` the skill gate is off by
design (`gateZ` and `gateFloor` both reach 0), leaving only a 30% MAE allowance,
and `conservatismFor` defends that in terms this plan should not overrule:

> The skill numbers get worse as this goes up, by construction. That is not a
> regression: MAE is minimised by the flat answer, so any model that moves more
> pays for it. **Judge this one in Lightroom, not in `BASELINE.md`.**

The owner has confirmed boldness 1 by eye on real shoots. A floor at zero would
undo exactly that trade for 9 colour parameters and 15 B&W ones — including
`Exposure2012`, `Contrast2012`, `Shadows2012`, `Clarity2012` and `Texture`, the
sliders most visible in the editor. Whether "worse on average but worth opening
in Lightroom" is acceptable for the frame head is a taste judgement, and it is
the photographer's.

**Decision, 2026-08-24: leave it.** `--boldness` stays the only knob on the frame
head. B&W within-shoot keeps reading −0.0021 and the report now says so out loud,
which is the honest outcome rather than a hidden one.

The reasoning, recorded so it is not reopened by the next reader of that −0.0021:

- The trade is already exposed and already chosen. Anyone who wants the floor
  gets it by lowering `--boldness`, which is what that knob is for.
- A floor at zero would have reached the sliders most visible in the editor —
  `Exposure2012`, `Contrast2012`, `Shadows2012`, `Clarity2012`, `Texture` — on
  the strength of a number the boldness documentation explicitly says not to
  judge them by.
- A per-branch variant was rejected as a special case. A gate that needs a table
  of exceptions stops being explicable, and explicability is most of what the
  three-state contract is for.

**A4 and this are not in tension, and the line between them is worth stating.**
A4's floor is on the *whole parameter*: end-to-end negative means the model loses
to the photographer's own average outright, and no taste setting justifies
shipping that. The frame head is a *component* of a parameter that may still be
winning overall, and trading some of its average error for reach is a documented,
deliberate choice. One is a correctness floor; the other is a taste knob.

## A — combined migration

**No entry.** Track A closed without a schema change: A1 and A2 were reverted,
A3 was not built, and A4 adds fields while changing no stored layout. An old
profile keeps working and simply reports fewer details.

Must state: no re-export is needed (`develop train` alone is enough); the
feedback journal survives; `develop calibrate` must be re-run because the
offsets were measured against a model that no longer exists.

`npm run docs:migrations` regenerates `docs/migrations.md`; `preversion` already
gates on `--check`.

## A — regenerate the baseline

`BASELINE.md` is regenerated **once**, when the next thing that moves a number lands, from a single
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

> **Superseded 2026-10-28.** New order: L1 (plugin, fast operations) → L2 + W
> (catalog export, local app) → L3 (apply predictions) → shell and XMP removal →
> beta data program (C) → 1.0 freezes the plugin ↔ engine contract. Editor
> adapters after Lightroom are post-launch. The original sequencing below is
> kept for the record.

**0.8.0 — the contract, part one.** B1 and whatever of Track B is ready. A4 is
already in. **No migration and no forced retrain** — Track A closed without
touching the schema.

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
