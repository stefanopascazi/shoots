# Rating profiles

A rating is **not universal**. A street photographer, a wedding shooter and a
wildlife photographer value different things, and set the keeper bar at very
different heights. A profile captures both axes explicitly.

```sh
shoots rate ./raw --profile wedding
```

---

## What a profile decides

### 1. WHAT matters — `meritWeights`

How the per-aspect CLIP scores combine into a single aesthetic merit. Aspects
absent from the map count **zero**.

### 2. HOW strict — the star cut-offs and the focus gate

Where the 0–5 boundaries sit, and how hard technically-soft frames are punished.

| Field | Meaning |
| --- | --- |
| `focusReject` | Focus below this = technical reject, **0 stars**, regardless of content |
| `focusSoft` | Focus below this = soft/missed focus, capped at `focusSoftCap` |
| `focusSoftCap` | The star ceiling applied to soft frames |
| `aestheticStars` | Merit cut-offs, descending. The first one the merit clears wins. |

### The skill-level axis

For a **beginner**, technical aspects (exposure, sharpness, composition) *should*
earn stars — nailing them is a real achievement. For a **professional** they are
table stakes, so pro-oriented profiles zero them out and let content decide.

That axis lives in the same two fields: different weights, different thresholds.

---

## The aspects

Seven contrastive aspect pairs, scored zero-shot by CLIP:

| Aspect | Probes |
| --- | --- |
| `overall` | General photographic quality |
| `composition` | Framing and structure |
| `exposure` | Technical exposure quality |
| `subject` | Subject presence and isolation |
| `sharpness` | Perceived acuity |
| `lighting` | Quality of light |
| `storytelling` | Narrative / the moment |

Every aspect is always scored and recorded in the sidecar, regardless of the
profile's weights. The profile only decides how they aggregate — so you can
re-derive a rating under a different profile without re-running inference.

---

## Built-in profiles

### `street` — the default

> Street / documentary — content over craft, unforgiving bar **(calibrated)**

| | |
| --- | --- |
| Weights | `storytelling` 1.5 · `overall` 1.2 · `subject` 1.0 · `lighting` 1.0 |
| Focus gate | reject `0.30`, soft `0.55`, soft cap **1★** |
| 5★ at | merit ≥ `0.63` |
| 1★ at | merit ≥ `0.50` |

Technical competence is *assumed*, so exposure, sharpness and composition are
zeroed entirely. Deliberately unforgiving: on a real shoot the mass of frames
lands at 0 stars. That is the intended behaviour — you want the tail, not a
flattering distribution.

**This is the only profile calibrated against a real, hand-judged shoot.**

### `generic`

> All-round, forgiving — technical competence counts *(prior)*

| | |
| --- | --- |
| Weights | `overall` 1.2 · `subject` 1.0 · `storytelling` 1.0 · `composition` 1.0 · `lighting` 1.0 · `exposure` 0.8 · `sharpness` 0.8 |
| Focus gate | reject `0.30`, soft `0.50`, soft cap **2★** |
| 5★ at | merit ≥ `0.62` |
| 1★ at | merit ≥ `0.38` |

A sensible default for a beginner or a mixed set. Technical craft counts toward
the score and the bar is much lower, so a clean, well-made frame already earns a
star or two.

### `portrait`

> Portrait — subject & light lead, eyes must be sharp *(prior)*

| | |
| --- | --- |
| Weights | `subject` 1.5 · `lighting` 1.2 · `overall` 1.0 · `sharpness` 0.6 · `composition` 0.5 · `storytelling` 0.5 |
| Focus gate | reject `0.35`, soft `0.60`, soft cap **1★** |
| 5★ at | merit ≥ `0.62` |

The subject and the light on it carry the frame. The focus gate is stricter —
a soft portrait is a miss.

### `wildlife`

> Wildlife — sharp subject & behaviour, strict focus *(prior)*

| | |
| --- | --- |
| Weights | `subject` 1.5 · `sharpness` 1.2 · `storytelling` 1.0 · `overall` 1.0 · `lighting` 0.8 |
| Focus gate | reject `0.40`, soft `0.65`, soft cap **1★** |
| 5★ at | merit ≥ `0.62` |

The hardest focus gate of any profile: a soft animal is simply a miss.

### `wedding`

> Wedding — forgiving, a clean frame already counts *(prior)*

| | |
| --- | --- |
| Weights | `subject` 1.2 · `overall` 1.2 · `lighting` 1.0 · `storytelling` 1.0 · `exposure` 0.8 · `composition` 0.6 |
| Focus gate | reject `0.30`, soft `0.50`, soft cap **2★** |
| 5★ at | merit ≥ `0.60` |
| 1★ at | merit ≥ `0.37` |

Deliberately forgiving: on a wedding, a clean well-exposed frame is already a
usable pick, and you deliver volume.

> **Known limit.** True emotion and expression scoring is what a wedding profile
> most wants, and the current model has no such aspect. It arrives with a future
> model archive. Until then this profile is a reasonable prior, not a calibrated
> judge.

---

## Choosing a profile

The presets are **priors**, not truth. Only `street` is calibrated. The honest way
to choose:

```sh
# Take 50 frames you have already judged yourself, then compare
for p in street generic portrait wildlife wedding; do
  echo "── $p"
  shoots rate ./sample-50 --profile "$p" --dry-run --json \
    | jq -r '.results[] | "\(.stars)★ \(.file | split("/") | last)"' \
    | sort -r
done
```

Pick the one that agrees with you most often. If none does — and that is a common,
legitimate outcome — train your own.

---

## Learned profiles

The real answer to "none of the presets is my eye" is to learn one from your own
judgements. See [Preference learning](./preference-learning.md) for the full
pipeline.

### Installing one

Drop the profile JSON into `~/.shoots/profiles/` and it becomes selectable by
filename:

```sh
cp my-eye.json ~/.shoots/profiles/
shoots rate ./raw --profile my-eye
```

Built-in names **win** over user profiles, so do not name a learned profile
`street` — it would be silently shadowed.

### The `linear-embedding` shape

Learned profiles use `type: "linear-embedding"`: the merit is a linear head over
the CLIP embedding, `s(x) = w·x + b`, squashed into `[0,1]`. The star cut-offs then
apply to that normalized score exactly as with a built-in profile.

```jsonc
{
  "type": "linear-embedding",
  "name": "my-eye",
  "description": "Learned from 800 duels, June 2026",
  "embeddingModel": "onnx-clip/vit-b32-int8-2",   // guards the embedding space
  "dim": 512,
  "weights": [ /* 512 floats */ ],
  "bias": -0.14,
  "scoreNormalization": { "mean": 0.02, "std": 0.31 },
  "focusReject": 0.3,
  "focusSoft": 0.55,
  "focusSoftCap": 1,
  "aestheticStars": [
    { "min": 0.78, "stars": 5 },
    { "min": 0.62, "stars": 4 },
    { "min": 0.45, "stars": 3 },
    { "min": 0.28, "stars": 2 },
    { "min": 0.12, "stars": 1 }
  ]
}
```

### Validation

Because these are external JSON files, **every field is validated before use**. A
malformed profile fails loudly with exit `2` rather than producing silent garbage
stars:

```
error: invalid profile my-eye.json: weights must be 512 finite numbers
```

`embeddingModel` guards that the profile is applied to the same CLIP space it was
learned on. Applying a profile trained on one model archive to another is a
category error and is rejected.

### Listing what is available

An unknown profile name prints the full list — built-ins plus everything in
`~/.shoots/profiles`:

```
error: unknown rating profile 'foo' (available: street, generic, portrait, wildlife, wedding, my-eye, client-work)
```

---

## Profiles in the pipeline config

```yaml
- id: first-pass-rating
  run: rate
  args: ${raw}
  with:
    profile: wedding
    mark: true        # or `write-xmp: true` if nothing writes a sidecar after it
```

See [Pipelines](./pipelines.md).

---

## See also

- [`rate`](./commands/rate.md) — the command that consumes profiles
- [Preference learning](./preference-learning.md) — train your own
- [`embeddings`](./commands/embeddings.md) — the profile-neutral export profiles are learned from
