# `shoots embeddings`

Export raw CLIP image embeddings and profile-neutral per-aspect scores, for
downstream preference-learning tooling.

```
shoots embeddings <path> [options]
```

---

## Why this is separate from `rate`

| | `rate` | `embeddings` |
| --- | --- | --- |
| **Opinionated?** | Yes — a `--profile` shapes the stars | **No** — profile-neutral by construction |
| **Emits** | Stars + keywords, as sidecars | Raw 512-d embedding + all aspect scores |
| **For** | Judging a shoot | Training a model on *your* eye |

If `embeddings` inherited a preset's bias, anything you trained on it would learn
that preset, not you. So it emits the raw signal and lets the trainer decide.

The `model` name is recorded in the dataset to **pin the embedding space** — a
learned profile can then refuse to be applied to a mismatched backend.

---

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<path>` | yes | Folder (recursive) or single file to embed |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--model <kind>` | `onnx` | Inference backend. Currently only `onnx`. |
| `--out <dir>` | — | Write a self-contained **bundle** (`embeddings.json` + `previews/`) to this directory |
| `--previews <mode>` | `auto` | When to generate browser previews in bundle mode: `auto` (RAW only) \| `always` \| `never` |
| `--preview-size <px>` | `1024` | Max preview edge in bundle mode |
| `--preview-quality <q>` | `82` | JPEG quality for previews (1–100) |
| `--concurrency <n>` | half the logical CPUs, capped at 8 | Max parallel embedding jobs |
| `--no-cache` | off | Re-embed every frame instead of reusing what a previous run worked out ([`shoots cache`](./cache.md)) |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

---

## Two output modes

### `--json` — dataset on stdout

The consolidated dataset, embeddings included, no previews. Good when your
consumer already knows how to display the source images (i.e. they are JPEGs).

```sh
shoots embeddings ./jpegs --json > dataset.json
```

### `--out <dir>` — a self-contained bundle

```
bundle/
├── embeddings.json
└── previews/
    ├── 000_IMG_0001.jpg
    ├── 001_IMG_0002.jpg
    └── ...
```

RAW originals are not browser-viewable, so the bundle carries JPEG previews for
duel UIs and any web tool. Each result gains a `preview` field holding a path
**relative to the dataset file**, so the bundle is movable.

Previews come from the embedded RAW preview (via exiftool), resized and
EXIF-oriented with sharp.

#### `--previews` modes

| Mode | Behaviour |
| --- | --- |
| `auto` *(default)* | Preview **RAW only**. Already-viewable images are referenced directly and the consuming UI serves the originals. |
| `always` | Preview everything — handy to downscale huge JPEGs so a browser UI stays responsive. |
| `never` | Write only `embeddings.json`. |

---

## Examples

### Bundle a RAW shoot for the duel UI

```sh
shoots embeddings D:/Shoots/2026/street-june --out ./bundle
```

```
Wrote bundle to ./bundle: embeddings.json + 1204 previews in previews/ (dim 512)
```

### Everything previewed, smaller and lighter

```sh
shoots embeddings ./mixed-catalog --out ./bundle \
  --previews always --preview-size 800 --preview-quality 75
```

### JSON only, no previews

```sh
shoots embeddings ./jpegs --json > dataset.json
shoots embeddings ./raw --out ./bundle --previews never
```

### Human-readable check

```sh
shoots embeddings ./sample
```

```
IMG_0001.CR3  dim=512  aspects=7  seed=0.573  [street, urban, candid]
IMG_0002.CR3  dim=512  aspects=7  seed=0.541  [portrait, indoor]

2/2 embedded with onnx-clip/vit-b32-int8-2 (dim 512)
```

### Feed the preference-learning pipeline

```sh
shoots embeddings ~/Pictures/my-best-work --out ./bundle
shoots match import --data ./bundle/embeddings.json --name my-eye
shoots match serve --name my-eye                  # duel at http://127.0.0.1:4576
shoots match train --name my-eye                  # → ~/.shoots/profiles/my-eye.json
shoots rate ./new-shoot --profile my-eye --write-xmp
```

Full walkthrough: [Preference learning](../preference-learning.md).

---

## Dataset format

```json
{
  "command": "embeddings",
  "model": "onnx-clip/vit-b32-int8-2",
  "dim": 512,
  "results": [
    {
      "file": "D:/raw/IMG_0001.CR3",
      "embedding": [0.021374, -0.045912, "… 512 floats …"],
      "aspects": [
        { "name": "overall", "score": 0.612 },
        { "name": "composition", "score": 0.554 }
      ],
      "keywords": ["street", "urban", "candid"],
      "focus": 0.812,
      "aestheticSeed": 0.573,
      "preview": "previews/000_IMG_0001.jpg"
    }
  ],
  "errors": [],
  "summary": { "total": 1204, "embedded": 1204, "failed": 0 }
}
```

| Field | Meaning |
| --- | --- |
| `model` | Pins the CLIP space. A learned profile carries this and refuses a mismatch. |
| `dim` | Embedding dimensionality (512 for ViT-B/32) |
| `embedding` | **L2-normalized** CLIP image embedding, rounded to 6 decimals |
| `aspects` | All per-aspect scores, profile-independent |
| `focus` | Technical focus score |
| `aestheticSeed` | **Unweighted mean** of the aspects — a weak, genre-agnostic seed for ranking, *not* a profile aggregate. `null` when the archive ships no aesthetics. |
| `preview` | Bundle mode only; path relative to `embeddings.json` |

> `aestheticSeed` exists to give an active-learning pairing strategy somewhere to
> start before any duels exist. Do not mistake it for a rating.

In bundle mode, the `--json` document on stdout omits `results` (they are already
in the file) and adds `out` and `previews` fields instead.

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | All files embedded |
| `1` | At least one file failed to embed |
| `2` | Unknown `--model` or `--previews` mode, or the model / exiftool could not be provisioned |

---

## See also

- [Preference learning](../preference-learning.md) — the full duels → profile pipeline
- [`rate`](./rate.md) — the opinionated consumer of the same model
- [Rating profiles](../profiles.md) — what a learned profile looks like
