# Pipelines

Declarative YAML pipelines you can version and share across a studio — the same
idea as a CI config, applied to a photography workflow.

```
shoots pipeline <config.yaml> [--var name=value] [--from <id>] [--dry-run]
```

Not a YAML person? `shoots pipeline init` asks two to four questions and writes
the scaffolding — the format described below, with every command left on its own
defaults and the interesting flags offered as commented hints you edit in. See
[`pipeline init`](./commands/pipeline.md#pipeline-init).

A pipeline is a list of shoots commands, in order, sharing one set of variables.
Nothing more: every step is the command you would have typed, so anything the CLI
can do a pipeline can do — including commands added after you wrote the file.

---

## Why pipelines

Pipelines are plain files on purpose:

- **Version them** — a studio's ingest process lives in git alongside everything
  else.
- **Share them** — a second shooter runs the same pipeline, identically.
- **Run them headless** — cron, CI, a watch folder.
- **Review them** — a config diff is legible in a way a shell-script diff is not.
- **Say the path once** — `exif`, `rate`, `cull` and `develop edit` all take the
  same folder, and a variable is how it stays the same folder.

---

## A complete example

`examples/wedding-pipeline.yaml` — the develop pipeline, card to sidecars:

```yaml
version: 2
name: wedding-ingest

vars:
  card: E:/DCIM/100CANON
  shoot: D:/Shoots/2026/smith-wedding
  raw: ${shoot}/raw            # vars may build on the ones above them
  studio: Jane Doe Photography

defaults:
  concurrency: 8               # applied wherever the command accepts it

steps:
  - id: offload
    run: import
    args: ${card}
    with:
      dest: ${raw}
      move: false

  - id: name-frames
    run: rename
    args: ${raw}
    with:
      pattern: "{date}_{time}_{camera}_{seq:4}.{ext}"
      recursive: true

  - id: studio-tags
    run: exif
    args: ${raw}
    with:
      set-artist: ${studio}
      set-copyright: "© 2026 ${studio}. All rights reserved."
      set-keywords: [wedding, smith, "2026"]

  - id: first-pass-rating
    run: rate
    args: ${raw}
    with:
      profile: wedding
      mark: true

  - id: focus-check
    run: cull
    args: ${raw}
    with:
      mark: true
      mark-label: reject
      threshold: 100             # Laplacian variance; tune per camera/subject

  - id: develop
    run: develop edit
    args: ${raw}
    with:
      treatment: auto
```

Run it — after looking at what it will do:

```sh
shoots pipeline examples/wedding-pipeline.yaml --dry-run
shoots pipeline examples/wedding-pipeline.yaml
```

Same pipeline, next shoot, without touching the file:

```sh
shoots pipeline examples/wedding-pipeline.yaml --var shoot=D:/Shoots/2026/jones-wedding
```

`examples/model-upkeep.yaml` is the other shape — the model-side chains
(`develop export` → `develop train`, and the `develop refine` loop).

---

## Schema

### Top level

| Field | Required | Description |
| --- | --- | --- |
| `version` | yes | Config schema version. Currently always `2`. |
| `name` | no | Human-readable pipeline name, used in the report |
| `vars` | no | Values referenced as `${name}` anywhere in the file |
| `defaults` | no | Flags applied to every step whose command accepts them |
| `steps` | yes | Non-empty list of steps, executed in order |

### Every step

| Field | Required | Description |
| --- | --- | --- |
| `run` | **yes** | The shoots command. Subcommands are space-separated: `develop export`. |
| `args` | no | Positional arguments — a single value or a list |
| `with` | no | Options, by their long-flag name |
| `id` | no | Stable identifier for the report and `--from`. Defaults to `run`. Must be unique. |
| `enabled` | no | Set `false` to skip without deleting the step. Default `true`. |
| `continue-on-error` | no | Keep going if this step fails. Default `false`. |

There is no per-command schema to learn: `with:` maps onto the flags in
[the command reference](./commands/README.md), and `shoots <command> --help` is
the authoritative list.

---

## Mapping `with:` onto flags

| YAML | Command line |
| --- | --- |
| `threshold: 100` | `--threshold 100` |
| `profile: wedding` | `--profile wedding` |
| `mark: true` | `--mark` |
| `move: false` | *(nothing — the flag stays off)* |
| `focus-rescue: false` | `--no-focus-rescue` *(when the command declares that form)* |
| `set-keywords: [a, b]` | `--set-keywords a,b` |
| `writeXmp: true` | `--write-xmp` |

Key names are forgiving: `write-xmp`, `writeXmp` and `--write-xmp` all name the
same flag. Values are not — a value on a boolean flag, or a flag the command does
not have, is a load error.

**Positional arguments go in `args:`, not `with:`.** `shoots rate <path>` is
`run: rate` + `args: <path>`.

### `defaults`

A default is applied only to steps whose command actually declares that option, so
`concurrency: 8` at the top of a file is harmless for the steps that do not take
it. A step's own `with:` always wins.

---

## Variables

`${name}` is replaced anywhere in `args`, `with`, `run` and in later `vars`.

```yaml
vars:
  shoot: D:/Shoots/2026/smith-wedding
  raw: ${shoot}/raw
  proofs: ${shoot}/proofs
```

- `${env:NAME}` reads an environment variable. Unset is an error, not an empty
  string.
- `--var name=value` (repeatable) overrides the file. The override is applied
  *before* the file's own vars resolve, so `raw: ${shoot}/raw` follows it.
- An undefined variable is a load error. Nothing runs against a half-built path.
- `$${...}` is a literal `${...}`.

> Filename templates use single braces (`{date}_{seq:4}.{ext}`) and are left
> untouched — the two languages do not collide.

> **YAML detail.** A value starting with `${` must be quoted inside a *flow*
> sequence: `args: ["${raw}"]`. Unquoted works in the scalar and block forms —
> `args: ${raw}`, or a `-` list — which is why the examples use those.

---

## Validation

The whole file is checked against the real command definitions **before the first
step runs**, and every problem is reported at once:

```
error: 4 problem(s) in wedding-pipeline.yaml:
  · steps[0] (rate): 'rate' needs 1 positional argument(s) <path> — got 0. Positional arguments go in `args:`, not `with:`.
  · steps[0] (rate): 'rate' has no option '--profil' (available: --concurrency, --dry-run, --json, --mark, --model, --profile, --verbose, --write-xmp)
  · steps[1] (cul): no such shoots command 'cul' (available: cull, develop, doctor, …)
  · steps[2] (develop): 'develop' needs a subcommand — one of: calibrate, clean, diagnose, edit, export, …
```

This is the point of the command: a misspelt flag in the last step is otherwise
discovered forty minutes in, after the earlier steps have already written to your
photographs.

Steps with `enabled: false` are **not** validated, so a step naming a command this
build does not have yet can sit parked in the file without breaking it.

---

## Running

Steps run in order, each as a child process — the same isolation the interactive
shell uses, so a step that crashes cannot take the pipeline's report down with it.

```
▶ wedding-ingest — 6 step(s)

[1/6] offload
      shoots import E:/DCIM/100CANON --concurrency 8 --dest D:/Shoots/2026/smith-wedding/raw
…

── wedding-ingest failed in 4m12s
  ✓ offload                  1m04s
  ✓ name-frames              3.1s
  ✗ studio-tags              exit 1, 2.0s
  · first-pass-rating        skipped (earlier step failed)
  · focus-check              skipped (earlier step failed)
  · develop                  skipped (earlier step failed)

Fix it, then resume with `--from studio-tags`.
```

The first failure stops the pipeline; later steps are reported as skipped rather
than dropped, so what did *not* happen to your photographs is on the screen.
`continue-on-error: true` on a step exempts it; `--continue-on-error` exempts all
of them. Either way the pipeline's own exit code is `1` if anything failed.

### Options

| Option | Description |
| --- | --- |
| `--var <name=value>` | Override a variable. Repeatable. |
| `--from <id>` | Resume: skip every step before this one |
| `--dry-run` | Validate and print the command lines; run nothing |
| `--continue-on-error` | Keep going after a failing step, whatever the file says |
| `--json` | Machine-readable report on stdout; step output goes to stderr |
| `--verbose` | Verbose logging on stderr |

> `--dry-run` on the pipeline prints the plan. To dry-run the *steps* — every
> command reporting what it would write — put `dry-run: true` in their `with:`.

Relative paths resolve against the directory you run the command from, not the
directory the YAML lives in.

---

## Migrating from version 1

Version 1 used typed steps (`type: import` with per-command fields). It was
documented as authorable but was never executable, and its steps carried no
paths — they assumed a file set flowing between handlers, which the
command-per-step model does not have. Version 2 replaces it, and the translation
is mechanical:

```yaml
# version 1                     # version 2
- type: import                  - run: import
  source: E:/DCIM                 args: E:/DCIM
  dest: D:/raw                    with:
  pattern: "{orig}.{ext}"           dest: D:/raw
  move: false                       pattern: "{orig}.{ext}"
                                    move: false
```

The step types that took no path (`exif`, `cull`, `rate`) now need one in `args:`,
which is the thing version 1 could not express. Loading a `version: 1` file
reports this and stops.

---

## Consuming configs from code

```ts
import { loadPipelineConfig, parsePipelineConfig, type PipelineConfig } from '@shoots/core';

const config: PipelineConfig = await loadPipelineConfig('./wedding-pipeline.yaml', {
  vars: { shoot: 'D:/Shoots/2026/jones-wedding' },
});

for (const step of config.steps) {
  if (!step.enabled) continue;
  console.log(step.id, '→', step.run, ...step.args);
}
```

Both throw `PipelineConfigError`, whose `.issues` array holds every problem found.
Resolution against the command definitions lives in the CLI
(`packages/cli/src/pipeline/resolve.ts`), because that is where the commands are.

Definitions: `packages/core/src/pipeline/PipelineConfig.ts`.

---

## See also

- [`shoots pipeline`](./commands/pipeline.md) — the command reference
- [Scripting & automation](./scripting.md) — the shell-script alternative
- [Recipes](./recipes.md) — the same workflows as scripts
- [Filename templates](./templates.md) — the `pattern` token language
- `examples/wedding-pipeline.yaml`, `examples/model-upkeep.yaml`
