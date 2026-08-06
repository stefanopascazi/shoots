# Direction

What `shoots` is trying to be, what is being worked on, and what it will not
become. This page is intentionally short on dates: it records intent, and intent
that has not shipped is not a promise.

Current release: **0.6.2**. The tool is pre-1.0 — the commands below are in
daily use, but the shape of a young one can still change between minor versions.
What each release asks of you is in the [migration notes](./migrations.md).

---

## Design goals

These are the constraints every feature is measured against. They are not
expected to change.

| Goal | What it means in practice |
| --- | --- |
| **Nothing is destroyed** | Originals are never deleted or overwritten. Edits go to sidecars, rejects are moved and not removed, every mutating command accepts `--dry-run`. |
| **Everything runs locally** | No cloud, no upload. The models ship to `~/.shoots` and run on your machine, on your photographs. Nothing about a prediction requires a network. |
| **The CLI stays free** | Every command documented here is free to run, with no subscription. Paid work, if it happens, is addons and studio-scale features alongside the CLI — never a toll on what already works. |
| **Scriptable before interactive** | Every command speaks `--json` and returns meaningful exit codes. The shell is a front for the CLI, never the only way to do something. |
| **An orchestration layer, not an editor** | `shoots` sits before and after Lightroom / Capture One and automates the tedium around them. XMP sidecars are the interface. |
| **Editor-agnostic** | The engine runs with no host editor installed. Any editor plugin is a thin front over it, never a dependency of it. |
| **Honest about what it knows** | A model that cannot support a prediction says so, and reaches only as far as its evidence carries it. |

## Where it stands

| Area | State |
| --- | --- |
| [`import`](./commands/import.md), [`rename`](./commands/rename.md), [`exif`](./commands/exif.md) | Stable. The template engine and the metadata layer are settled. |
| [`cull`](./commands/cull.md), [`rate`](./commands/rate.md), [`triage`](./commands/triage.md) | Stable. Focus-aware culling and CLIP rating, with review. |
| [Preference learning](./preference-learning.md) — `embeddings`, `match` | Working end to end: duels in, a personal rating profile out. |
| [Develop predictor](./develop-predictor.md) — `develop` | The active front. Usable, and the part still moving fastest. |
| [Pipelines](./pipelines.md), [`schedule`](./commands/schedule.md) | Recent. The YAML surface may still gain steps — there are no conditionals yet. |
| [`setup`](./commands/setup.md), [`doctor`](./commands/doctor.md), [`update`](./commands/update.md), [`release-notes`](./commands/release-notes.md) | Stable. Provisioning, self-update and the migration notes that apply to your machine. |

## Next

The develop predictor is where the work is. In order:

- **Per-frame skill, not per-shoot averages.** *Shipped in 0.6.0*: a profile is
  two models added together, one reading the shoot and one reading only how far
  this frame departs from it, so two frames of the same shoot stop getting the
  same answer. **Still open**: the in-shoot spread remains below a
  photographer's own, and closing that gap is the single biggest problem left.
  Black-and-white is the weakest branch by a wide margin (in-shoot skill ~4%
  against ~16% for colour).
- **Calibration you can trust by eye.** *Shipped through 0.6.2*:
  `develop calibrate --review` judges one correction at a time in real units, on
  the region it acts on, rendered on the GPU as a viewport with a loupe; colour
  and black-and-white are now calibrated separately on their own photographs
  instead of one number decided on colour frames alone. **Still open**: the
  preview approximates the host's pipeline rather than reproducing it, so it
  answers *how much*, not *exactly what Lightroom will show*.
- **Fewer frames to a useful profile.** Not started. Training still wants a
  sizeable edited catalog, and lowering that floor is what decides whether the
  predictor is for everyone or only for photographers with an archive.

## Editors

The predictor speaks to an editor through an **adapter**, and adapters are the
main axis of growth.

| Editor | State |
| --- | --- |
| Lightroom Classic, Camera Raw, Bridge | **Supported** — the `acr` adapter, via XMP `crs:` sidecars |
| [RapidRAW](https://github.com/CyberTimon/RapidRAW) | **Implemented, calibration open** — the `rapidraw` adapter, via `.rrdata` JSON sidecars. Works end to end; the numeric mapping is still being compared against real edits. No B&W: the app has no grayscale mode |
| darktable | Queued |
| RawTherapee | Queued |
| ON1 Photo RAW | Queued |
| Capture One | Queued — the hardest, it does not use XMP for adjustments at all |

Each one is real work rather than a flag: develop settings do not transfer
between editors, and an exposure of +0.35 means whatever the host's pipeline
says it means. What the adapter interface buys is that this is the *only* place
that has to know — the schema, the model and the evaluation stay in one
vocabulary behind it. The order is not fixed; demand moves it.

RapidRAW was the first test of that claim, and it held: JSON instead of RDF,
white balance stated relative to the capture instead of absolutely, no
black-and-white branch at all, and no exiftool on either side. None of it reached
past the adapter's own directory. What it *did* expose was that triage had an
Adobe assumption baked into shared code — the annotation write went through
exiftool and the sidecar it created was RDF — so an adapter now owns that write
too, and the marks and the develop settings can share one file safely.

The open half is calibration, and it is worth stating plainly rather than
discovering: a profile is learned from *your* catalog, which today means
Lightroom, so the numbers are ACR's and the adapter converts them with factors
borrowed from RapidRAW's own preset importer. On top of that, ACR sliders are
offsets from a base rendering (a camera profile plus a Look) that RapidRAW has no
equivalent of. Expect a systematic shift, not a faithful transfer — see the
[develop predictor guide](./develop-predictor.md) for how to tell the two apart.
Closing this means measuring against real edits, not reading more source.

## Later

Candidates, not commitments — listed so the intent is visible before any of it
is built.

None of these has been started.

- **More rating profiles** for genres the five built-ins (`street`, `generic`,
  `portrait`, `wildlife`, `wedding`) do not cover.
- Richer **pipeline steps** — conditionals, and reuse of a pipeline as a step.
- **Selection help beyond focus**: near-duplicate grouping, eyes-closed and
  expression checks on the frames culling leaves behind.

## Non-goals

Things that would make `shoots` a different tool, and are therefore out of scope
whatever the demand:

- **Becoming an editor.** No local masks, no generative fill, no retouching. The
  deliverable is the best starting point to refine, not a finished image.
- **Becoming a DAM.** No catalog database, no asset manager, no library UI. Your
  editor already owns that.
- **Cloud inference.** Sending photographs to a third party for a better model is
  not a trade this tool will make. Any account the project ever asks for is for
  usage analytics and the things that live outside the CLI — never a gate in
  front of a prediction.
- **Editing in place.** No feature will ever earn the right to overwrite an
  original.

---

Disagree with any of it, or need something that is not here?
[Open an issue](https://github.com/stefanopascazi/shoots/issues).
