# Pipelines

Declarative YAML pipelines you can version and share across a studio — the same
idea as a CI config, applied to a photography workflow.

> ## Status: authorable, not yet executable
>
> The config schema, the parser and the handler-based `PipelineRunner` are
> implemented in `@shoots/core`. **The `shoots run <config.yaml>` command that
> registers command logic as step handlers lands in a later stage.**
>
> The types are stable and the format is versioned, so pipelines you write today
> are designed to run unchanged when the command ships. Until then, use
> [shell scripts](./scripting.md) — [Recipes](./recipes.md) has ready-made ones.

---

## Why pipelines

Pipelines are plain files on purpose:

- **Version them** — a studio's ingest process lives in git alongside everything
  else.
- **Share them** — a second shooter runs the same pipeline, identically.
- **Run them headless** — cron, CI, a watch folder.
- **Review them** — a config diff is legible in a way a shell-script diff is not.

---

## A complete example

`examples/wedding-pipeline.yaml`:

```yaml
# Sample shoots pipeline: card → tagged → culled → rated.
version: 1
name: wedding-ingest

steps:
  - type: import
    id: offload-card
    source: "E:/DCIM/100CANON"
    dest: "D:/Shoots/2026/smith-wedding/raw"
    pattern: "{date}_{time}_{camera}_{seq:4}.{ext}"
    move: false            # copy only; checksum-verified either way

  - type: exif
    id: studio-tags
    set:
      artist: "Jane Doe Photography"
      copyright: "© 2026 Jane Doe Photography. All rights reserved."
      keywords: [wedding, smith, "2026"]

  - type: cull
    id: focus-check
    threshold: 100         # Laplacian variance; tune per camera/subject
    separate: true
    dest: "D:/Shoots/2026/smith-wedding/culled"

  - type: rate
    id: first-pass-rating
    profile: wedding
    output: sidecar

  # Future stage — declared now so this config keeps working unchanged later.
  - type: export
    id: client-proofs
    enabled: false
    format: jpeg
    maxDimension: 3000
    quality: 90
    dest: "D:/Shoots/2026/smith-wedding/proofs"
```

---

## Schema

### Top level

| Field | Required | Description |
| --- | --- | --- |
| `version` | yes | Config schema version. Currently always `1`. |
| `name` | no | Human-readable pipeline name |
| `steps` | yes | Non-empty list of steps, executed in order |

An unsupported `version`, a missing `steps`, or an empty `steps` list is a
validation error.

### Every step

| Field | Required | Description |
| --- | --- | --- |
| `type` | yes | `import` \| `exif` \| `cull` \| `rate` \| `export` |
| `id` | no | Stable identifier, useful for logs and a future resume-from-step |
| `enabled` | no | Set `false` to skip without deleting the step. Default `true`. |

`enabled: false` is the right way to park a step you are not ready to run — it
keeps the intent visible in the file.

---

## Step types

### `import`

| Field | Required | Description |
| --- | --- | --- |
| `source` | **yes** | Source directory or file |
| `dest` | **yes** | Destination directory |
| `pattern` | no | [Filename template](./templates.md), same tokens as `import --pattern` |
| `move` | no | Move instead of copy. Source deleted only after checksum verification. Default `false`. |

```yaml
- type: import
  source: "E:/DCIM/100CANON"
  dest: "D:/Shoots/2026/smith-wedding/raw"
  pattern: "{date}_{time}_{camera}_{seq:4}.{ext}"
  move: false
```

### `exif`

| Field | Required | Description |
| --- | --- | --- |
| `set` | **yes** | Mapping of tags to write |

Well-known keys `artist`, `copyright` and `keywords` map to `Artist`, `Copyright`
and `Keywords`. Any other key is passed to exiftool verbatim, so full `Group:Tag`
syntax works.

```yaml
- type: exif
  set:
    artist: "Jane Doe Photography"
    copyright: "© 2026 Jane Doe Photography"
    keywords: [wedding, smith, "2026"]
    XMP:City: "Rome"
    IPTC:Credit: "Jane Doe Photography"
```

> Quote bare years: unquoted `2026` is a number, and keywords must be strings.

### `cull`

| Field | Required | Description |
| --- | --- | --- |
| `threshold` | no | Laplacian-variance threshold below which a file is blurry |
| `separate` | no | Separate keepers from rejects. Default `false` (report only). |
| `dest` | no | Where separated files go |

```yaml
- type: cull
  threshold: 100
  separate: true
  dest: "D:/Shoots/2026/smith-wedding/culled"
```

### `rate`

| Field | Required | Description |
| --- | --- | --- |
| `model` | no | Inference backend. Only `onnx` today. |
| `profile` | no | [Rating profile](./profiles.md). Default: the built-in default. |
| `output` | no | `sidecar` (JSON) or `xmp`. Default `sidecar`. |

```yaml
- type: rate
  profile: wedding
  output: xmp
```

### `export` — future stage

Declared now so configs stay forward-compatible.

| Field | Required | Description |
| --- | --- | --- |
| `dest` | **yes** | Output directory |
| `format` | no | `jpeg` \| `png` \| `webp` |
| `maxDimension` | no | Longest edge in pixels |
| `quality` | no | Encoder quality |

```yaml
- type: export
  enabled: false
  format: jpeg
  maxDimension: 3000
  quality: 90
  dest: "D:/Shoots/2026/smith-wedding/proofs"
```

---

## Validation

Configs are **structurally validated on load**, before any step runs:

- `version` must be `1`.
- `steps` must be a non-empty list of mappings.
- Every `type` must be a known step type.
- `import` requires non-empty `source` and `dest`; `export` requires `dest`;
  `exif` requires a `set` mapping.

Errors name the offending step by index:

```
steps[2].type must be one of: import, exif, cull, rate, export (got cul)
steps[0].dest must be a non-empty string
Unsupported pipeline config version: 2 (expected 1)
```

`cull` and `rate` have no required fields — every option has a default.

---

## Until `run` ships

Translate the pipeline into a shell script. The mapping is direct:

```yaml
- type: import
  source: "E:/DCIM/100CANON"
  dest: "D:/Shoots/2026/smith-wedding/raw"
  pattern: "{date}_{time}_{camera}_{seq:4}.{ext}"
```

```sh
shoots import E:/DCIM/100CANON \
  --dest D:/Shoots/2026/smith-wedding/raw \
  --pattern "{date}_{time}_{camera}_{seq:4}.{ext}"
```

[Recipes](./recipes.md) has complete scripted equivalents of the common pipelines,
including a nightly watch-folder version.

---

## Consuming configs from code

The types and loader are exported from `@shoots/core` today:

```ts
import { loadPipelineConfig, parsePipelineConfig, type PipelineConfig } from '@shoots/core';

const config: PipelineConfig = await loadPipelineConfig('./wedding-pipeline.yaml');

for (const step of config.steps) {
  if (step.enabled === false) continue;
  console.log(step.id ?? step.type, '→', step.type);
}
```

`parsePipelineConfig(yamlText)` does the same from a string. Both throw
`PipelineConfigError` on invalid input.

Definitions: `packages/core/src/pipeline/PipelineConfig.ts`.

---

## See also

- [Scripting & automation](./scripting.md) — the shell alternative available today
- [Recipes](./recipes.md) — scripted equivalents of common pipelines
- [Filename templates](./templates.md) — the `pattern` token language
- `examples/wedding-pipeline.yaml` — the sample config in the repo
