# Direction

What `shoots` is trying to be, what is being worked on, and what it will not
become. This page is intentionally short on dates: it records intent, and intent
that has not shipped is not a promise.

Current release: **0.7.\***. The tool is pre-1.0 — the commands below are in
daily use, but the shape of a young one can still change between minor versions.
What each release asks of you is in the [migration notes](./migrations.md).

> **Direction change.** Until launch, `shoots` targets **Lightroom Classic
> only**, through a plugin and a local app it opens. The interactive shell and
> every other editor are paused, and XMP sidecars are being replaced by reading
> and writing the Lightroom catalog directly.

---

## Design goals

These are the constraints every feature is measured against.

| Goal | What it means in practice |
| --- | --- |
| **Nothing is destroyed** | Originals are never deleted or overwritten. Edits go through the Lightroom catalog, rejects are moved and not removed, every mutating command accepts `--dry-run`. |
| **Everything runs locally** | No cloud inference. The models ship to `~/.shoots` and run on your machine, on your photographs. Nothing leaves it without an explicit opt-in, and even then only derived measurements — never an image. |
| **The CLI stays free** | Every command documented here stays free to run. The commercial product is the Lightroom Classic plugin built on top of it. |
| **Scriptable before interactive** | Every command speaks `--json` and returns meaningful exit codes. The plugin and its local app are fronts for the CLI, never the only way to do something. |
| **An orchestration layer, not an editor** | `shoots` sits before and after Lightroom and automates the tedium around it. The plugin is the interface. |
| **Lightroom first** | One host, done properly, before any other. The engine keeps its adapter interface, so other editors stay additive later. |
| **Honest about what it knows** | A model that cannot support a prediction says so, and reaches only as far as its evidence carries it. |

## Where it stands

| Area | State |
| --- | --- |
| [`import`](./commands/import.md), [`rename`](./commands/rename.md), [`exif`](./commands/exif.md) | Stable. The template engine and the metadata layer are settled. |
| [`cull`](./commands/cull.md), [`rate`](./commands/rate.md), [`triage`](./commands/triage.md) | Stable. Focus-aware culling and CLIP rating, with review. First candidates for the plugin. |
| [Preference learning](./preference-learning.md) — `embeddings`, `match` | Working end to end: duels in, a personal rating profile out. |
| [Develop predictor](./develop-predictor.md) — `develop` | Usable. Every parameter states whether it is `predicted`, `leveled` or `constant`, and none ships with negative held-out skill. More progress now waits on data, not code. |
| [Pipelines](./pipelines.md), [`schedule`](./commands/schedule.md) | Recent. The surface may still gain steps — there are no conditionals yet. |
| [`setup`](./commands/setup.md), [`doctor`](./commands/doctor.md), [`update`](./commands/update.md), [`release-notes`](./commands/release-notes.md) | Stable. Provisioning, self-update and the migration notes that apply to your machine. |
| [`cache`](./commands/cache.md) | `cull`, `rate`, `embeddings` and `develop export` share what they derive, so a re-run costs nothing. |
| [Shell](./shell.md) | **Being removed.** The plugin replaces it; every command it fronted stays on the CLI. |
| Test suite | Every package carries unit tests (`packages/*/test`), run together by `npm test`. |

## Next

In order:

- **Lightroom Classic plugin.** The fast operations first — culling, rating,
  picks and labels written straight into the catalog, no sidecars.
- **A local app the plugin opens.** Training, calibration and review in the
  browser, served on your machine: opening it from Lightroom starts the server,
  closing it stops it. Built on `@shoots/ui`, a shared design system (tokens,
  dark/light themes, Preact components) meant for every shoots web surface.
- **Train from the catalog.** The plugin exports your develop settings as JSON;
  training reads that instead of XMP sidecars. XMP support is removed once this
  is in place.
- **A closed beta that shares data.** Testers who opt in share derived
  measurements, never images, so the develop predictor can learn from many
  photographers instead of one. After the beta, sharing becomes an explicit
  opt-in in the plugin, off by default.

## Editors

| Editor | State |
| --- | --- |
| Lightroom Classic | **The focus** — via the plugin, reading and writing the catalog. The current XMP adapter is being replaced. |
| [RapidRAW](https://github.com/CyberTimon/RapidRAW) | **Paused** — the adapter works end to end, but is not maintained until after launch. |
| darktable, RawTherapee, ON1 Photo RAW, Capture One | **Paused** until after launch. |

The engine speaks to an editor through an **adapter**, and that interface stays:
develop settings do not transfer between editors, and the adapter is the only
place that has to know. Adding an editor later is additive work, not a rewrite.

## Later

Candidates, not commitments. None of these has been started.

- **More rating profiles** for genres the five built-ins (`street`, `generic`,
  `portrait`, `wildlife`, `wedding`) do not cover.
- Richer **pipeline steps** — conditionals, and reuse of a pipeline as a step.
- **Selection help beyond focus**: near-duplicate grouping, eyes-closed and
  expression checks on the frames culling leaves behind.
- **Other editors**, in the order demand sets.

## Non-goals

Things that would make `shoots` a different tool, and are therefore out of scope
whatever the demand:

- **Becoming an editor.** No local masks, no generative fill, no retouching. The
  deliverable is the best starting point to refine, not a finished image.
- **Becoming a DAM.** No catalog database of its own, no asset manager. The local
  app runs jobs; Lightroom owns the library.
- **Cloud inference.** Sending photographs to a third party for a better model is
  not a trade this tool will make. An account exists for usage analytics and
  opt-in data sharing — never as a gate in front of a prediction.
- **Editing in place.** No feature will ever earn the right to overwrite an
  original.

---

Disagree with any of it, or need something that is not here?
[Open an issue](https://github.com/stefanopascazi/shoots/issues).
