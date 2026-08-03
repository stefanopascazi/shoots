# photometric-pairs

Builds a self-supervised training set for a **photometric encoder** — a model that
looks at a photograph and says how far it sits from its own as-shot reference in
exposure and white balance.

Not part of the shipped CLI. It produces research data, and it runs from source
without the workspace being built.

## Why this exists

The develop predictor's bottleneck is its input, not its regressor. CLIP is
trained to be *invariant* to exposure, white balance and contrast — precisely the
quantities the tone sliders depend on — and the 50 hand-rolled photometric
features only partly cover the gap (`Temperature` scores −2.1% on the reference
catalog and is gated, while inter-retoucher agreement says white balance is the
single most image-driven parameter there is).

Training a better encoder normally needs RAW→edit pairs, and every public dataset
of those (FiveK, PPR10K, INRetouch) is non-commercial. This sidesteps that: the
label is a degradation *we applied*, so no photographer's edit is needed and any
RAW is usable — including the ~80% of an archive that was never edited.

## Usage

```sh
npm run data:pairs -- --in D:/Archivio/2024 --out D:/datasets/photometric
```

| flag | default | |
|---|---|---|
| `--in` | — | directory searched recursively for RAWs |
| `--out` | — | dataset directory (`images/` + `pairs.jsonl`) |
| `--variants` | 5 | renders per RAW; variant 0 is always the undegraded reference |
| `--size` | 512 | longest edge, px |
| `--quality` | 92 | JPEG quality, 4:4:4 |
| `--ev` | 2 | exposure error sampled from ±this, in stops |
| `--mired` | 60 | white-balance error sampled from ±this, in mired |
| `--tint` | 20 | green–magenta error sampled from ±this |
| `--limit` | 0 | stop after N RAWs (0 = all) — use it for a first run |
| `--jobs` | cores/2 | concurrent decodes |
| `--seed` | 1 | perturbations are deterministic in (seed, relative path) |
| `--force` | off | re-render images that already exist |

Needs `dcraw_emu`, which `shoots setup` provisions; `SHOOTS_LIBRAW` overrides it.

Safe to interrupt and re-run: existing images are skipped, and because the
degradations derive from the seed and the relative path, the manifest is rebuilt
in full either way. Adding files to `--in` never perturbs the labels of the ones
already there.

## Output

`pairs.jsonl`, one line per rendered image:

```json
{"id":"1f4c…_3","source":"2024/wedding/IMG_0421.CR2","variant":3,
 "ev":-1.2841,"mired":37.412,"tint":-8.03,
 "kelvinFrom":5500,"kelvinTo":4680.2,"image":"images/1f4c…_3.jpg"}
```

`ev`, `mired` and `tint` are the **labels** — the error the encoder must recover.
They are relative to the as-shot render, which is the same anchor the develop
predictor encodes its targets against, so the encoder's output drops into the
existing feature vector without a change of units.

## Design notes

- **One decode per RAW.** In scene-linear light an exposure error and a white
  balance error are per-channel multiplications, so all variants come from a
  single `dcraw_emu -w -4 -o 1 -h` render. Re-invoking the developer per variant
  would be five times the cost for an identical result.
- **`-4`, not the CLI's `-o 1 -q 0`.** 16-bit linear with auto-brighten off. An
  auto-brightened reference would silently undo the exposure error being
  introduced.
- **Resize before degrading.** Averaging pixels is only physically meaningful in
  linear light, and it also moves the transfer-function work off the full-size
  image.
- **Mired, not Kelvin.** 200K at 3000K is a colour cast; at 9000K it is
  invisible. Mired is the unit a shift is roughly uniform in.
- **The anchor is nominal (5500K).** The render already carries the camera's
  as-shot balance, so the shift has to be relative, and mired makes the residual
  dependence on the true as-shot temperature small. `develop export` records the
  real as-shot Kelvin per file, so a later revision can anchor per image.

## What this does not do

It teaches the *corrective* half of editing — where the exposure and the white
point should sit. It cannot teach taste: nothing here has ever seen a
photographer's choice. That is the correct division of labour, since the
corrective half is the part that is predictable from the image at all.
