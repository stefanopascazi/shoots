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
| `--json` | Every record on stdout: `caption`, `objects` (label + box as fractions of the frame), `regions` |
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

Pixels come from the RAW's embedded preview, turned upright, the same source
`cull` and `rate` read.
