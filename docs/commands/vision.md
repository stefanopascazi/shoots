# `shoots vision`

Read each photograph with the vision model and keep what it found: a caption,
the objects in the frame, and where the sky and the subject are. Keywords and
region intents are built on this; they run the same pass themselves for any
frame that has not been read, so this command is the up-front, resumable way to
pay for a whole shoot.

```
shoots vision <path> [--no-cache] [--json]
```

| Option | Description |
| --- | --- |
| `--no-cache` | Read every frame again instead of reusing what a previous run found |
| `--json` | Every record on stdout: `keywords`, `caption`, `objects` (label + box as fractions of the frame), `regions` |
| `--verbose` | Verbose logging on stderr |

The model is Florence-2-base-ft (Microsoft, MIT), run locally on the CPU. It is
**630 MB** and not part of the default `shoots setup`: the first command that
needs it downloads it, or `shoots setup --vision` does it up front. Expect a few
seconds per photograph; results are cached per file and file version, so a
second run over the same shoot is near-instant.

## What is recorded

- **caption**: a paragraph describing the scene.
- **objects**: what the detector names, with boxes.
- **regions**: masks for the **sky** and the **subject** (a person), on a 48×48
  grid. A region is recorded only when the photograph contains it, judged from
  the caption and the detected objects. The model will draw a mask for any
  phrase you ask for, present or not, so it is never asked for one blind.

## Keywords

Derived from the record, not scored against a list: scene words (portrait,
beach, wedding, street, indoor or outdoor…) only when the caption says them,
and the detector's objects that cover at least 2 % of the frame and are not worn
by someone in it (a floral print on a dress is not a flower photograph). Indoor
and outdoor are decided between, never both.

Judged by eye on 20 frames of a real catalog that played no part in writing the
rules: 8 % of these keywords were wrong, against 39 % for the CLIP keywords
`rate` writes today. They are fewer (about three per photograph, against six).

Pixels come from the RAW's embedded preview, turned upright, the same source
`cull` and `rate` read.
