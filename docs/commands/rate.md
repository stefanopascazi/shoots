# `shoots rate`

Score images for focus and aesthetics, suggest keywords, and map the result to a
**0–5 star rating** written to sidecars.

```
shoots rate <path> [options]
```

Backed by a local ONNX **CLIP** model (`vit-b32-int8`) running on
`onnxruntime-node`. Everything happens on your machine; nothing is uploaded.

---

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<path>` | yes | Folder (recursive) or single file to rate |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--model <kind>` | `onnx` | Inference backend. Currently only `onnx`. |
| `--profile <name>` | `street` | Rating profile: `street`, `generic`, `portrait`, `wildlife`, `wedding`, or a learned profile in `~/.shoots/profiles` |
| `--mark` | off | Record stars and keywords as a triage mark instead of writing a sidecar |
| `--write-xmp` | off | Write `.xmp` sidecars via exiftool instead of JSON sidecars |
| `--concurrency <n>` | half the logical CPUs, capped at 8 | Max parallel scoring jobs |
| `--no-cache` | off | Re-embed every frame instead of reusing what a previous run worked out ([`shoots cache`](./cache.md)) |
| `--dry-run` | off | Score and report, but write no sidecars |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

---

## How a rating is produced

Three stages, all local:

### 1. Focus score

A technical gate. Below the profile's `focusReject` the frame is a technical
reject (0 stars) regardless of content. Between `focusReject` and `focusSoft` it is
capped at the profile's `focusSoftCap`.

### 2. Aesthetic merit — zero-shot, multi-aspect

The image embedding is compared against contrastive **aspect** prompt pairs
("a well-composed photograph" vs "a badly composed photograph"). Each aspect
yields a probability in `[0,1]`:

| Aspect | What it probes |
| --- | --- |
| `overall` | General photographic quality |
| `composition` | Framing and structure |
| `exposure` | Technical exposure quality |
| `subject` | Subject presence and isolation |
| `sharpness` | Perceived acuity |
| `lighting` | Quality of light |
| `storytelling` | Narrative / moment |

The **profile** decides how those combine into a single merit score. Aspects a
profile does not weight count zero.

### 3. Stars

The merit score is compared against the profile's descending cut-offs; the first
one it clears wins. The focus gate then caps the result if needed.

**This is why `--profile` matters more than any other flag.** A street profile
scores content and ignores technical craft; a beginner-friendly profile rewards
nailing exposure and sharpness. Same photo, legitimately different stars. See
[Rating profiles](../profiles.md).

### Keywords

Zero-shot keywording against a vocabulary whose text embeddings ship precomputed
inside the model archive — the runtime only needs the image encoder plus a cosine
similarity, so no text encoder or tokenizer is loaded.

---

## Output formats

### JSON sidecars (default)

`<file>.shoots.json`, written next to each image:

```json
{
  "file": "D:/raw/IMG_0001.CR3",
  "model": "onnx-clip/vit-b32-int8-2",
  "profile": "street",
  "stars": 4,
  "scores": { "focus": 0.812, "aesthetic": 0.591 },
  "aspects": [
    { "name": "overall",      "score": 0.612 },
    { "name": "composition",  "score": 0.554 },
    { "name": "exposure",     "score": 0.701 },
    { "name": "subject",      "score": 0.588 },
    { "name": "sharpness",    "score": 0.744 },
    { "name": "lighting",     "score": 0.566 },
    { "name": "storytelling", "score": 0.573 }
  ],
  "keywords": ["street", "urban", "candid"],
  "generatedAt": "2026-07-28T09:14:22.104Z"
}
```

The full per-aspect breakdown is recorded regardless of the profile's weights —
provenance, so you can re-derive a rating under a different profile without
re-running inference.

### Triage marks (`--mark`) — the composable option

Nothing is written next to the photographs. The stars and keywords are recorded
under `~/.shoots/triage` and merged into a sidecar later, by `develop edit` or
`shoots triage apply`.

```sh
shoots cull ./shoot --mark
shoots rate ./shoot --mark      # adds stars to the same records
shoots develop edit ./shoot     # one sidecar carrying crs + label + stars
```

Prefer this whenever the shoot has more than one step. `--write-xmp` writes the
sidecar immediately, which means whichever command runs last owns the file;
marks merge field by field instead. See [`triage`](./triage.md).

### XMP sidecars (`--write-xmp`)

`<file>.xmp`, written via exiftool, carrying `XMP:Rating` and `XMP:Subject`.
**Lightroom, Bridge and Capture One read these directly.**

> `rate --write-xmp` **refuses to overwrite an existing `.xmp`** and reports that
> file as an error. Your own edits are never clobbered. Move or delete the
> existing sidecars if you truly want to re-rate — or use `--mark`, which merges
> rather than refusing.

---

## Examples

### First look — score without writing anything

```sh
shoots rate ./raw --dry-run
```

```
★★★★☆  IMG_0001.CR3  focus=0.812 aesthetic=0.591  [street, urban, candid]
★★☆☆☆  IMG_0002.CR3  focus=0.774 aesthetic=0.531  [portrait, indoor]
☆☆☆☆☆  IMG_0003.CR3  focus=0.201 aesthetic=0.498  [blurry, motion]

482/482 rated with onnx-clip/vit-b32-int8-2 (profile: street) (dry run, no sidecars written)
```

### Rate a wedding with the matching profile

```sh
shoots rate D:/Shoots/2026/smith-wedding --profile wedding --write-xmp
```

Lightroom will show the stars on import.

### Compare profiles on the same folder

```sh
for p in street generic portrait wedding; do
  echo "── $p"
  shoots rate ./sample --profile "$p" --dry-run --json \
    | jq -r '.results[] | "\(.stars)★ \(.file | split("/") | last)"'
done
```

The best way to pick a profile is to run it on 50 frames you have already judged
yourself, and see which one agrees with you.

### Use your own learned profile

```sh
# Trained via the preference-learning pipeline — see ../preference-learning.md
shoots rate ./raw --profile my-eye --write-xmp
```

`my-eye` resolves to `~/.shoots/profiles/my-eye.json`. Built-in names win over
user profiles, so avoid naming a learned profile `street`.

### Full JSON pipeline

```sh
# The 5-star selects
shoots rate ./raw --json | jq -r '.results[] | select(.stars == 5) | .file'

# Copy 4+ star frames into a selects folder
shoots rate ./raw --json \
  | jq -r '.results[] | select(.stars >= 4) | .file' \
  | xargs -I{} cp {} ./selects/

# Star distribution
shoots rate ./raw --json | jq -r '.results[].stars' | sort | uniq -c
```

### On a constrained machine

```sh
shoots rate ./raw --concurrency 2
```

ONNX inference holds real memory per parallel job.

---

## JSON output

```json
{
  "command": "rate",
  "model": "onnx-clip/vit-b32-int8-2",
  "profile": "street",
  "dryRun": false,
  "results": [
    {
      "file": "D:/raw/IMG_0001.CR3",
      "stars": 4,
      "focus": 0.812,
      "aesthetic": 0.591,
      "aspects": [ { "name": "overall", "score": 0.612 } ],
      "keywords": ["street", "urban", "candid"],
      "sidecar": "D:/raw/IMG_0001.CR3.shoots.json",
      "model": "onnx-clip/vit-b32-int8-2"
    }
  ],
  "errors": [],
  "summary": { "total": 482, "rated": 482, "failed": 0 }
}
```

`sidecar` is `null` under `--dry-run`.

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | All files rated |
| `1` | At least one file failed (e.g. an existing `.xmp` blocking a write) |
| `2` | Unknown `--model` or `--profile`, an invalid learned profile, or the model / exiftool could not be provisioned |

---

## Notes and limits

- **The ratings are strict by design.** The default `street` profile is
  unforgiving: on a real shoot the mass of frames legitimately lands at 0–1 stars.
  That is the point — you want the tail, not a flattering average. Use `generic`
  or `wedding` for a more forgiving bar.
- **Only `street` is calibrated** against a real, hand-judged shoot. The others
  are reasonable starting priors. The fix is not a better preset — it is
  [learning your own profile](../preference-learning.md).
- **Some genres want aspects the current model lacks** — emotion and expression,
  most obviously for weddings. Those arrive with a future model archive.
- **The model is licensed for commercial redistribution.** The aesthetic path is
  deliberately zero-shot CLIP (MIT) rather than an AVA-trained aesthetic scorer,
  because AVA-derived weights are not commercially clean.

---

## See also

- [Rating profiles](../profiles.md) — what each profile weights, and how to pick
- [Preference learning](../preference-learning.md) — train a profile on your own eye
- [`cull`](./cull.md) — non-ML blur detection; run it *before* rating
- [`triage`](./triage.md) — where `--mark` puts the ratings, and how they get out
- [`embeddings`](./embeddings.md) — the profile-neutral export
