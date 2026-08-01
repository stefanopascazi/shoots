# Migration notes

What each release asks of you — the steps that cannot be derived from a
changelog. `shoots release-notes` prints the entries below that still apply to
this machine, checked against the profile and dataset in `~/.shoots`.

> Generated from `packages/cli/src/release-notes/migrations.ts`. Do not edit by hand.

---

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

