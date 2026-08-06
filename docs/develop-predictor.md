# Develop predictor — the local "Lightroom AI"

A personal **develop-setting predictor**: it learns your develop style from your
own catalog and predicts a per-image develop starting point for a new shoot.

Command reference: [`shoots develop`](./commands/develop.md).

---

## Scope — read this first

**What it does:** predicts the *global look* as an Adobe Camera Raw (process 2012)
develop vector, and writes it as an `.xmp` sidecar.

**What it does not do:** local masks, generative edits, retouching, or a finished
edit. The goal is **the best starting point to refine**, not a delivered image.

**It is editor-agnostic.** The engine runs without any host editor installed. An
**adapter** decides how an edit is read and written, selected with `--editor`.
There is one today — `acr`, the default — which speaks XMP `crs:` sidecars and is
read by Lightroom Classic, Camera Raw and Bridge. Capture One does *not* read
develop adjustments from XMP and will need an adapter of its own. Plugins for
specific editors are thin fronts over this same engine, not a dependency of it.

---

## What is predicted

The develop vector splits into two **branches** by treatment. The split is
deterministic from the edit itself: black-and-white uses the GrayMixer, colour uses
HSL, and they are mutually exclusive.

### `shared` — predicted for every photo

| Group | Parameters |
| --- | --- |
| Tone | `Exposure2012`, `Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Blacks2012` |
| Presence | `Texture`, `Clarity2012`, `Dehaze` |
| White balance | `Temperature`, `Tint` |
| Parametric curve | `ParametricHighlights`, `ParametricLights`, `ParametricDarks`, `ParametricShadows` |
| Point curve | `ToneCurvePoint0` … `ToneCurvePoint255` — nine knots (see below) |
| Calibration | `ShadowTint`, `RedHue`, `RedSaturation`, `GreenHue`, `GreenSaturation`, `BlueHue`, `BlueSaturation` |
| Effects | `PostCropVignetteAmount`, `GrainAmount` |

**Both curves, because which one you use is a habit.** The parametric sliders and
the point curve do the same job through different controls, and a schema that
bets on one is blind to the photographer who uses the other. The nine point-curve
knots are synthetic keys — ACR stores the curve as an `rdf:Seq` of `"x, y"`
points, with no per-knot tag to name — sampled onto a fixed grid so a
fixed-width regressor can predict it, each with the identity curve as its
neutral. `predict` rebuilds the Seq and forces the outputs non-decreasing.

On black-and-white the curve is not a garnish, it *is* the conversion, so the
report always shows these knots even though their loss weight keeps them out of
the headline (which measures image-dependence, a different question).

### `color` — colour photos only

`Vibrance`, `Saturation`, the **24 HSL adjustments** (Hue/Saturation/Luminance ×
Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta), colour grading
(shadow/midtone/highlight/global — hue, sat, lum, plus blending and balance), and
split toning.

### `bw` — black-and-white photos only

The 8-channel grayscale mixer.

A model is trained **per treatment** over `shared + <branch>`, so a high-contrast
B&W edit and a light colour edit never average into a mush.

### Captured but not predicted

The full edit *is* captured in the dataset — including sharpening and noise
reduction — but only the look above is *learned as a target*. Sharpening and
noise reduction are **finishing**, not starting point.

The **base rendering** (camera profile + Look) is a third case: not a target, but
not merely captured either. It conditions the model as an input, and `predict`
writes it into the sidecar — every predicted slider is relative to it, and
leaving it out drops the whole edit onto Lightroom's legacy default. See
[the develop command reference](commands/develop.md#the-base-rendering-is-written-into-the-sidecar).

The exact list, ranges, branches and loss weights live in
`packages/cli/src/develop/develop/schema.ts`.

---

## Design decisions

### 1. Deltas, not absolutes

For sliders the neutral default is 0, so the delta *is* the value.

**White balance is the exception, and it is the single biggest accuracy lever.**
Temp/Tint are camera-calibration-relative — 5200K on a Canon is not 5200K on a
Sony. So WB is measured against the **as-shot** WB, with temperature in
log-Kelvin. Predicting absolute Temperature would mostly learn which camera took
the picture.

### 2. Per-parameter standardization + loss weighting

Parameter ranges differ wildly (`Exposure2012` spans −5..5, `Contrast2012` spans
−100..100). Each parameter's delta is z-scored so no single one dominates by unit
scale alone.

The go/no-go metric then **weights the image-dependent parameters** — exposure,
WB, contrast, highlights/shadows, dehaze/vibrance — and *expects* style-constant
parameters (HSL, colour grading) to collapse to your mean.

> A style-constant parameter collapsing to your mean is **correct, not a failure.**
> If you always apply the same subtle orange-shift to skin tones, "predict the
> mean" is the right answer and there is no image-dependent signal to find.

### 3. Two heads — the shoot, and the frame against it

Each treatment is fitted as **two** ridge models whose outputs are added:

- a **level** head, from the mean photometric description of the whole shoot,
  predicting where that shoot's slider sits;
- a **frame** head, from how far this photograph departs from that mean,
  predicting how far its slider should depart from the shoot's.

Fitted as one regression they do not coexist. The shoot average is a
near-noiseless predictor of that shoot's own offset, so ridge spends its budget
there and the per-frame columns come out at a tenth of their honest size — a
frame shot into the sun and one in open shade came back identical. Splitting the
heads buys **separate gates** (a slider can have an unpredictable per-shoot level
and a well-predicted per-frame response, or the reverse), **separate λ**, and a
**de-shrinking slope per head** that puts back the reach ridge cost.

This landed in **0.6.0** and it invalidates older profiles — see the
[migration notes](./migrations.md).

### 4. Anchored corrections — for the sliders a mean cannot serve

A shrunk regression is timid exactly where the correction needs to be large: a
frame wanting −1.5 stops comes back with −0.14, and de-shrinking cannot fix a
prediction that is flat. Some sliders are therefore predicted as a **correction
toward a target** instead:

```
slider = ȳ + gain · (x − x̄)
```

`x` is one measured property of *this* photograph, `x̄`/`ȳ` are your own averages,
and `gain` is the **unshrunk** slope. A frame far from your typical scene gets a
proportionally large correction by arithmetic, without the fit having ever seen a
frame that extreme. It is worse on average — an unshrunk slope always is — so the
trade is measured per parameter, on the frames it is meant to serve, before it is
taken. `train` lists these separately, with the anchor feature, the gain and the
tail skill; the head columns above do not describe them.

Two flags govern how far all of this travels, on `train`, `learn`, `refine` and
`init`:

| Flag | Default | What it does |
| --- | --- | --- |
| `--boldness <0..1>` | `0` | How far predictions may travel. `0` is safest averages, `1` moves the sliders. Skill scores *fall* as this rises — the number to judge it by is what your editor shows, not the report. |
| `--anchor-gain <n>` | `1` | Multiplies every anchored correction. Your gain differs per shoot, so this is the intensity knob you actually want. |

---

## The go/no-go GATE

`shoots develop train` reports, per parameter:

| Column | Meaning |
| --- | --- |
| **end-end** | The skill of the whole model: `1 − modelMae / baselineMae` against "apply my average edit", on shoots it has never seen. `> 0` is a win. |
| **± fold** | How far end-end moves between held-out folds. A change smaller than this is not a change. |
| **random** | The same skill with random folds instead of held-out sessions. The gap is session leakage. |
| **shoot** | How much of end-end comes from reading the *shoot*. |
| **in-shoot** | How much comes from reading THIS frame against its neighbours. |
| **reach** | How far the prediction is stretched back out after ridge shrank it. `1.00` is untouched; above that the fit was too timid. |
| **model MAE** | The held-out error itself. |

Rows are tagged `[never moves]`, `[constant]` (the level was gated) or
`[flat within a shoot]` (the frame head was gated).

**`in-shoot` is the column to read.** end-end can look healthy on a model that
only ever reproduces per-shoot averages; in-shoot is what decides whether a
backlit frame and one in open shade come back with different numbers.

λ is no longer a report column. It is chosen **per parameter and per head**,
because exposure and the HSL sliders do not want the same amount of shrinkage and
one shared λ is picked by an average the unpredictable majority dominates. The
gate pays for that search: λ is re-chosen inside each held-out fold, so no
parameter is scored on the split that picked it.

By default the report lists the parameters that carry the look, and closes with a
count of the ones it left out. Pass **`--all`** to see every parameter instead —
including the ones that never move away from their default, and the style sliders
with negative skill:

```
shoots develop train --data train.jsonl --name my-style --all
```

It changes the report only. The profile that gets written is identical either
way, so `--all` is never something you have to remember before training — it is
there for when a parameter you expected to be predicted is missing from the list,
and you want to see what its skill actually was.

> Not to be confused with `develop clean --all`, which is destructive: that one
> also removes the training dataset and the fitted profile.

**The headline number is the weighted skill over the image-dependent parameters.**

| Headline skill | Reading |
| --- | --- |
| Clearly positive | GO. There is real per-image signal. |
| Around zero | The model is no better than your average edit. |
| Negative | Something is wrong — check the baseline strategy and the dataset. |

If it is not clearly positive on a real catalog, **stop**. The signal is too weak
to build on, and the first thing to reconsider is the baseline render strategy.

Alongside it the branch reports a **within-shoot skill** — the same question
asked of frames from the same shoot only. A healthy headline with a
`within-shoot` near zero is a model that has learned your shoots, not your
photographs.

---

## The baseline render — why it matters most

The photometric features must come from a render of the image **before** the edit.
Get this wrong and everything downstream is noise.

**`develop init` and `develop edit` default to `external`** — the good one. Only
the bare `develop export` still defaults to `embedded-preview`, so a hand-built
pipeline is the one place you have to say which you want.

### `--baseline embedded-preview`

Uses the RAW's embedded JPEG preview.

- ✅ Zero setup, fast.
- ❌ An **approximation**. The preview bakes in the camera's per-model picture
  style, which pollutes the exposure and tone features.
- Expect absolute-luminance parameters (`Exposure2012`, `Whites2012`,
  `Blacks2012`) to stay near your photographer mean — the features simply do not
  carry the information needed to do better.

Fine for a **first signal**. Not the configuration to judge the method on.

### `--baseline external`

A stand-alone RAW developer produces a **neutral, camera-independent** render:
standard colour, camera WB, and crucially **no auto-brighten**, so the true scene
exposure survives into the features.

Zero-config — on first use it provisions LibRaw's `dcraw_emu` into `~/.shoots`,
checksum-verified from the mirror, exactly like exiftool. `shoots setup` fetches it
up front.

Override with your own developer, no editor involved:

```sh
# A local LibRaw dcraw_emu (needs LibRaw ≥ 0.20 for CR3)
export SHOOTS_RAW_DEVELOPER=dcraw_emu
# default args already target dcraw_emu: -w -W -o 1 -q 0 -T -Z {out} {in}

# …or RawTherapee-cli with a neutral profile
export SHOOTS_RAW_DEVELOPER=rawtherapee-cli
export SHOOTS_RAW_DEVELOPER_ARGS='-Y -q -o {out} -p neutral.pp3 -c {in}'
```

`{in}` / `{out}` are substituted per file; renders go to a temp dir. Only RAW files
are re-rendered — rendered formats use their own pixels. CLIP always stays on the
embedded preview, because it is colour-invariant and the extra render would buy
nothing.

The chosen strategy is recorded in both the dataset and the profile — and
`predict` **refuses** a profile and a dataset that disagree. The two renders put
the same photograph at a different luminance, contrast and white point, so a
profile trained on one reads a feature vector from a space it never saw. The
dimensions match either way, which is precisely why nothing else can catch it:

```
error: profile was trained on baseline 'external' but the dataset was exported
with 'embedded-preview' — the colour features are not comparable across
baselines. Re-export with `--baseline external`.
```

Export the set you predict on with the same `--baseline` you trained with.

### Target leak

For proprietary RAW (CR3/NEF/ARW) the embedded preview is the **camera JPEG** —
edit-independent, so there is no leak.

**DNG is the risk.** A DNG whose preview has been updated by the editor bakes the
edit into the "before" render, and the model appears to work brilliantly while
having learned nothing. If your catalog is DNG, verify this before trusting a
result.

---

## Complete workflow

```sh
# once, from a catalog you have already developed
# --review opens the screen that sets how hard each correction pushes
shoots develop init ~/Catalogs/2025-edited --review

# per shoot — sidecars land next to the photographs
shoots develop edit ~/Shoots/2026-07-new

# after developing them in Lightroom, see how much of the prediction survived
shoots develop feedback --predictions ~/.shoots/develop/export/shooting/2026-07-new/prediction.json

# close the loop: feedback + learn + calibrate, in the only order that works
shoots develop refine ~/Shoots/2026-07-new
```

`init` runs `export --edited-only` then `train`; `edit` runs `export` then
`predict`. Both use conventional paths under `~/.shoots/develop`, take every flag
of the steps they wrap, and accept `--dry-run`. `edit` refuses to overwrite
sidecars that already carry a real edit unless you pass `--force`.

Import the sidecars in Lightroom and every frame opens on your look, ready to
refine. `shoots develop status` says what the machine holds; `shoots develop
clean` drops the per-shoot working files and leaves the profile alone.

See the [develop command reference](commands/develop.md) for the individual
steps, and for `refresh-targets` when only the *target* side changed — a fixed
tag, a new schema parameter, a stricter "edited" test — which reuses the
embeddings and the neutral renders instead of re-exporting.

---

## Feedback — the only real-world metric

Every other number here is cross-validated on the catalog the profile was fitted
from. That answers "would this have matched an edit you already made". The
question the tool exists to answer is **how much of the starting point do you
keep**, and only `develop feedback` measures it.

```
  this shoot  kept 3.4% of the parameters either of us moved
              (58.4% counting the sliders we both left at neutral —
               that number flatters the model and is not the one to quote)
  journal     kept 3.6% over 21 images from 2 shoots

  over the journal (21 images), listed from 6 comparisons up:

  param                           moved   kept   journey   corrected by   offset
  Temperature                       590     0%       91%         463.21   +86.62
  Highlights2012                    590     0%       51%          21.54    +4.16
  Clarity2012                       251     0%      -12%           8.27    -0.14
  Dehaze                             14·    7%       22%           6.02    +1.30
```

- **kept** — left untouched. The product metric; held-out skill is its proxy.
- **journey** — how much of the move the prediction already made. Negative means
  it landed further off than leaving the slider alone.
- **offset** — the mean *signed* correction. A parameter you always nudge the
  same way is a missing constant, not a modelling failure.

It compares against whatever the file says today, so run it on a shoot you
actually developed *from* the sidecars — otherwise the gap is two independent
opinions rather than the model's error.

It accumulates, and it has to. A per-parameter rate over six images is noise, so
the table has a floor under it — which means one shoot of ten photographs can
never fill it in. Every run is therefore recorded in
`~/.shoots/develop/feedback.jsonl` and the breakdown is computed over everything
seen so far, with this run's own acceptance quoted separately above it. Ten
shoots of eight carry the same signal as one shoot of eighty; `develop status`
says how far along the journal is, and `develop clean` never touches it.

### Closing the loop — `develop calibrate`

The journal is not only a report. `shoots develop calibrate` turns it into a
**per-parameter constant offset** on the profile: the amount the predictions are
reliably wrong by, in the same direction, on every photograph. It is the only
step that improves the model from evidence the catalog does not contain.

It proposes a constant and nothing more, on purpose. The photographer edits
*from* the sidecar, so every observation is partly a reaction to what was
proposed; feeding that back as ground truth would teach the model that its own
output was right, and repeated, the predictions would stop tracking the
photographs and start tracking themselves. An offset is the one correction where
that anchoring is safe — accepting a value you would have pushed further only
makes the measured offset *smaller*, so the estimate errs toward
under-correcting. Half of it is applied, so the next round takes half of what is
left and the loop converges.

The offsets sit beside the model rather than inside it: `--reset` removes them,
`--dry-run` shows the decision first, `predict` reports how many it carries, and
a retrain invalidates them out loud.

#### Setting the intensity by eye — `--review`

The journal answers "how wrong was it", which needs a shoot you have already
developed. `--review` answers the question you have before that: **how hard
should this correction push?**

```sh
shoots develop train --data train.jsonl --name my-style --review
shoots develop calibrate --review     # re-open it later, no refit
```

It serves a local page that renders your own photographs on the GPU with one
anchored correction applied at a time, in real units, on the region that
correction acts on — a viewport with a loupe, not a contact sheet. Colour and
black-and-white are calibrated separately, on frames drawn from the records each
branch will actually apply to, and a branch with no photographs to show says so
and keeps its fitted gains.

The preview is deliberately an **approximation of the host's pipeline**, not a
reproduction of it. It exists to judge *how much*, not to develop a photograph.
`--review-port` and `--review-timeout` control the server; `0` waits forever.

Most of the value so far has been on **gated** parameters — those where the model
lost to "apply my average edit" and emits the photographer's constant instead. A
constant that is reliably wrong is exactly what an offset fixes, without touching
the model at all.

### The other half — `develop learn`

An offset cannot track something that varies, and the part of an edit that
changes photograph to photograph is most of what anyone would call an eye. That
only moves if the model is **refitted**, which means the corrected shoot has to be
inside the training set.

`shoots develop learn <shoot>` puts it there. Nothing is recomputed — `edit`
already left the shoot's embeddings and colour features on disk, and developing
the photographs changed only the targets, so those are re-read from the sidecars
and merged in by file.

The difference from simply adding more photographs to the catalog is the
**weight**. Each frame counts in proportion to how much of the prediction the
photographer had to change, normalized against the median correction for that
shoot: a typical correction weighs 1, like any catalog edit; twice the usual
weighs 2; a frame accepted almost untouched sinks to 0.25.

That is also the safeguard, and it is the same mechanism. Editing *from* a
prediction contaminates the target — a frame you accepted wholesale is largely
the model's own output returning as ground truth, which is how a model trained on
its own predictions collapses onto its own habits. Those frames have the smallest
corrections, so weighting by correction size **down-weights exactly the
contaminated samples without needing to identify them**. What dominates the refit
is where the photographer overruled the model: the least anchored evidence there
is.

Weights act on the fit and never on the score, so the GATE number stays
comparable across a refit; and standardization stays unweighted, so a corrected
shoot cannot redefine the constant a gated parameter emits. A refit does
invalidate any calibration — the offsets described a model that no longer
exists — so the order is refit → develop → `feedback` → `calibrate`.
`shoots develop refine <shoot>` runs that order for you.

---

## When the result is weak

### 1. Check the baseline

`embedded-preview` → `external` is the largest single improvement available, and
the first thing to check. `develop init` already defaults to `external`, so this
applies to a dataset built by hand with `develop export`, or to one exported
before that default changed — `develop status` says which baseline yours carries.

```sh
shoots develop export ~/Catalogs/2025-edited --edited-only \
  --baseline external --out train-neutral.jsonl
shoots develop train --data train-neutral.jsonl --name my-style-v2 \
  --out profiles/my-style-v2.json
```

### 2. Check for multiple styles

```sh
shoots develop diagnose --data train.jsonl
```

This compares **pooled** skill against **per-style (clustered)** skill. If
clustered is clearly better, your catalog holds several distinct looks — a moody
set and an airy set, editorial and personal work — and a single pooled model is
averaging them into mush.

The fix is to split the catalog and train one profile per look.

```sh
shoots develop diagnose --data train.jsonl --max-k 6 --folds 10
```

### 3. More edited images

Ridge regression over hundreds of parameters needs a real catalog. A few dozen
edits will not produce a stable model.

### 4. Check consistency

If you genuinely edit each image on its own terms with no through-line, there may
be no style to learn. That is a legitimate finding, not a bug.

### 5. Suspect a target that was never read

A `crs` tag requested under the wrong name comes back as *silence*, not an error,
and silence reads downstream as "the photographer never touched this" — a
constant target the trainer then scores as perfectly predicted. `train` flags
these as `[never moves]`, and `export` warns about tags absent from every file.

When you fix the target side, you do **not** need to re-export. The embeddings
and the neutral renders did not change; only the targets did:

```sh
shoots develop refresh-targets --data train.jsonl --out train-v2.jsonl
shoots develop train --data train-v2.jsonl --name my-style-v2 \
  --out profiles/my-style-v2.json
```

Minutes instead of hours — see
[`refresh-targets`](commands/develop.md#shoots-develop-refresh-targets).

---

## Known limits (v1)

- **Hue parameters are modelled linearly** although they are circular (0–360°) —
  colour grade, calibration and split-tone hues. Acceptable while they are
  near-constant per catalog, wrong if you swing hue wildly per image.
- **The tone curve is predicted as nine sampled knots**, not as the arbitrary
  point list a photographer can drag. A curve whose shape lives between the knots
  is approximated; the RGB channel curves are not predicted at all.
- **Global look only.** No local adjustments, no masks, no AI subject selection.
- **One profile per style.** The model has no per-image style routing. The
  treatment branch is picked per file (`--treatment auto`, the default, reads it
  from the edit), but choosing *between two of your own looks* is not something
  it does — train one profile per look.
- **The review preview approximates the host's pipeline.** Every control on the
  calibration screen is a model of the slider, not Camera Raw's implementation of
  it. Good enough to set an intensity; not a proof of what Lightroom will show.

---

## See also

- [`shoots develop`](./commands/develop.md) — full command reference
- [Migration notes](./migrations.md) — what a release asks of an existing profile
- [Configuration](./configuration.md) — `SHOOTS_RAW_DEVELOPER`, `SHOOTS_LIBRAW`
- `packages/cli/src/develop/develop/schema.ts` — the exact target vector
- `packages/cli/src/develop/train/train.ts` — the two heads
- `packages/cli/src/develop/train/anchor.ts` — the anchored corrections
