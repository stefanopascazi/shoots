# Migration notes

What each release asks of you — the steps that cannot be derived from a
changelog. `shoots release-notes` prints the entries below that still apply to
this machine, checked against the profile and dataset in `~/.shoots`.

> Generated from `packages/cli/src/release-notes/migrations.ts`. Do not edit by hand.

---

## 0.7.0 — Rename `--xmp` to `--sidecars` in your scripts (the old flag still works, and warns)

**Required:** no  
**Affects:** 

`shoots develop predict --xmp <dir>` was named after the file it wrote, back when there was only one editor to write for. There are two now: `--editor rapidraw` emits `.rrdata` JSON, and a flag called `--xmp` producing something that is not XMP is a lie the next adapter would have to keep telling. It is `--sidecars <dir>` from this release, and the adapter decides the format and the filename.

- `--xmp` still works. It prints a deprecation warning, is hidden from `--help`, and will be removed in a later release — nothing breaks today.
- Passing both is an error only when they name different directories, which is the one case where guessing would write your sidecars somewhere you did not ask for.
- Nothing stored changes: no profile, no dataset, no re-export, no retrain.
- `develop edit --dry-run --json` renamed the same key inside its plan, from `xmp` to `sidecars`. Only a script parsing that plan is affected.

## 0.6.0 — Retrain: the predictor now answers "what about THIS frame", not just "what about this shoot"

**Required:** yes  
**Affects:** profile

Predictions used to come back nearly identical for every photograph in a shoot — a frame shot into the sun and one in open shade both got the same Highlights. That was real: one regression had to explain both where a shoot sits and how its frames differ, and the shoot average always won, leaving the per-frame evidence with a tenth of its honest weight. A profile is now two models added together — one reading the shoot, one reading only how far this frame departs from it — each kept or dropped on its own evidence, and each stretched back to the amplitude that evidence supports instead of collapsing onto your average. A profile from 0.5.0 has a single weight matrix over a layout that no longer exists.

### What to do

```sh
shoots develop train --data <your-export> --name <your-profile>
```

- The export is unchanged — no re-export, and `develop train` alone is enough.
- The report gained an "in-shoot" column. That is the one to read when a prediction feels like a default: it measures whether the model tells two frames of the SAME shoot apart, which the headline number can look healthy without.
- On the reference catalog (428 colour frames, 32 shoots) the headline skill went 0.020 → 0.057 and Highlights 14% → 20%, while the spread of predicted Highlights inside a shoot doubled. It is still below the photographer's own spread, and deliberately so — the model reaches as far as the evidence carries it and no further.
- Re-run `develop calibrate` afterwards: the offsets were measured against a model that no longer exists.

## 0.5.0 — Re-run `develop init`: the colour features widened from 44 to 50

**Required:** yes  
**Affects:** profile, dataset

The develop predictor learned six new photometric features (lumaP01, lumaP99, shadowFloor, detailFine, detailCoarse, darkChannel) and now reads the capture hour out of the EXIF. Every profile and dataset built before this release describes an image with a narrower vector than the tool now produces, so `develop predict` and `develop learn` refuse them rather than predict from a feature space the model never saw.

### What to do

```sh
shoots develop init <your-edited-catalog>
```

- Nothing can be salvaged. `develop refresh-targets` does not help: the features changed, not the targets.
- The stored format did not change — SCHEMA_VERSION stays at 8 on purpose, only the width of the vector moved.
- Your feedback journal (`develop feedback`) survives the rebuild; re-run `develop calibrate` afterwards to re-measure the offsets against the new model.

