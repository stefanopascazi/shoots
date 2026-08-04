# `shoots pipeline`

Run a YAML pipeline: shoots commands in order, sharing one set of variables.

```
shoots pipeline <config> [options]
```

The full format is documented in [Pipelines](../pipelines.md). This page is the
command surface.

---

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<config>` | yes | Pipeline YAML file |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--var <name=value>` | — | Override a variable declared in the file. Repeatable. |
| `--from <id>` | — | Resume: skip every step before this one |
| `--dry-run` | off | Validate the file and print the command lines; run nothing |
| `--continue-on-error` | off | Keep going after a failing step, whatever the file says |
| `--json` | off | Machine-readable report on stdout (step output moves to stderr) |
| `--verbose` | off | Verbose logging on stderr |

---

## Behaviour

Each step is this same build, re-invoked as a child process — so a step behaves
exactly as it would if you had typed it, keeps its own progress view, and cannot
take the pipeline's report down with it when it crashes.

**The file is validated in full before the first step runs.** Every command name,
every flag and every positional count is checked against the real command
definitions, and every problem is reported at once with its `steps[i]` location.
A typo in the last step fails in a second, not forty minutes in.

The first failing step stops the pipeline. Remaining steps are reported as
skipped, and the report ends with the `--from <id>` line that resumes from the
failure once you have fixed it.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every step that ran succeeded |
| `1` | At least one step failed |
| `2` | The file could not be loaded, or does not resolve against this build's commands |

---

## Examples

Look before you leap:

```sh
shoots pipeline wedding.yaml --dry-run
```

```
Dry run — wedding-ingest: 6 step(s), nothing executed.

  [1/6] offload
        shoots import E:/DCIM/100CANON --concurrency 8 --dest D:/Shoots/2026/smith-wedding/raw
  [2/6] name-frames
        shoots rename D:/Shoots/2026/smith-wedding/raw --pattern {date}_{time}_{camera}_{seq:4}.{ext} --recursive
  …
```

The same pipeline against a different shoot:

```sh
shoots pipeline wedding.yaml --var shoot=D:/Shoots/2026/jones-wedding
```

Resume after fixing what broke:

```sh
shoots pipeline wedding.yaml --from studio-tags
```

Headless, for cron or CI:

```sh
shoots pipeline nightly.yaml --json > run.json || echo "pipeline failed"
```

---

## See also

- [Pipelines](../pipelines.md) — the YAML format, variables, and the flag mapping
- [Scripting & automation](../scripting.md) — the shell-script alternative
- [`schedule`](./schedule.md) — running `develop refine` unattended, nightly
