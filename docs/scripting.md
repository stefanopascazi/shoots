# Scripting & automation

`shoots` is built to be driven by scripts. Clean stdout, `--json` everywhere,
meaningful exit codes, no GUI dependency, no interactive prompts.

---

## The three guarantees

### 1. stdout is the result, stderr is the noise

| Stream | Carries |
| --- | --- |
| **stdout** | The command's result: human table, or the `--json` document |
| **stderr** | Logs, warnings, errors, progress bars, `--verbose` output |

In `--json` mode, human lines are suppressed entirely, so stdout holds **exactly
one JSON document**. Piping is always safe:

```sh
shoots cull ./raw --json | jq '.summary'
```

### 2. Exit codes are meaningful

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | One or more per-file operations failed |
| `2` | Bad usage — invalid flag, unknown profile, missing prerequisite |

A batch that fails on 3 of 500 files exits `1` **and still reports the 497
successes**. It does not abort on the first error.

```sh
shoots import E:/DCIM --dest ./raw --json || notify-failure
```

### 3. No TTY, no interactive UI

The Ink progress view activates only on a TTY. In cron, CI or a pipe you get plain
log lines on stderr. Nothing ever waits for input.

---

## JSON shapes

Every command follows the same skeleton:

```jsonc
{
  "command": "cull",
  "dryRun": false,
  "results": [ /* or "files" for import/rename/exif */ ],
  "errors":  [ { "file": "...", "error": "..." } ],
  "summary": { "total": 482, "failed": 0 }
}
```

`errors` is always present and always an array. `summary` always carries `total`
and `failed`.

Per-command shapes are documented on each [command page](./commands/README.md).

---

## `jq` recipes

```sh
# ── cull ──────────────────────────────────────────────────────────────────────
shoots cull ./raw --json | jq -r '.results[] | select(.verdict=="blurry") | .file'
shoots cull ./raw --json | jq -r '.results[] | select(.rescued) | "\(.score)\t\(.focusPeak)\t\(.file)"'
shoots cull ./raw --json | jq '.summary.blurry / .summary.total'

# ── rate ──────────────────────────────────────────────────────────────────────
shoots rate ./raw --json | jq -r '.results[] | select(.stars >= 4) | .file'
shoots rate ./raw --json | jq -r '.results[].stars' | sort | uniq -c
shoots rate ./raw --json | jq -r '.results[] | "\(.stars)\t\(.keywords|join(","))\t\(.file)"'

# ── exif ──────────────────────────────────────────────────────────────────────
shoots exif ./raw --json | jq -r '.files[].LensModel' | sort | uniq -c | sort -rn
shoots exif ./raw --json | jq -r '.files[] | select(.FNumber <= 2.0) | .SourceFile'
shoots exif ./raw --json | jq -r '.files[].ISO' | sort -n | uniq -c

# ── import ────────────────────────────────────────────────────────────────────
shoots import E:/DCIM --dest ./raw --json | jq -r '.files[] | select(.dateSource=="mtime") | .source'
shoots import E:/DCIM --dest ./raw --json | jq '.summary'

# ── doctor ────────────────────────────────────────────────────────────────────
shoots doctor --json | jq -r '.checks[] | select(.status != "ok") | "\(.status)\t\(.name)\t\(.detail)"'
shoots doctor --json | jq -e '.summary.failed == 0' > /dev/null
```

---

## Composing commands

### Copy the selects out

```sh
shoots rate ./raw --profile wedding --json \
  | jq -r '.results[] | select(.stars >= 4) | .file' \
  | xargs -I{} cp {} ./selects/
```

### Tag only the rejects

```sh
shoots cull ./raw --json \
  | jq -r '.results[] | select(.verdict=="blurry") | .file' \
  > blurry.txt

while read -r f; do
  shoots exif "$f" --set-keywords reject,soft-focus
done < blurry.txt
```

### Cull, then rate only the keepers

Because `cull --dest` **moves** rejects out, the keepers are simply what is left:

```sh
shoots cull ./catalog --dest ./rejects
shoots rate ./catalog --profile wedding --write-xmp
```

That ordering matters — it keeps the expensive ML step off frames you have already
rejected.

---

## Cron

```cron
# Nightly cull of an incoming watch folder
0 2 * * * /usr/local/bin/shoots cull /mnt/incoming --dest /mnt/rejects --json >> /var/log/shoots-cull.log 2>&1

# Weekly update check
0 6 * * 1 /usr/local/bin/shoots update --check --json >> /var/log/shoots-update.log 2>&1
```

Two cron-specific notes:

- **Use absolute paths.** cron's `PATH` is minimal.
- **Set `SHOOTS_HOME` if the cron user differs** from the user who ran `setup` —
  otherwise it resolves to a different home and re-downloads everything.

```cron
SHOOTS_HOME=/opt/shoots-home
0 2 * * * /usr/local/bin/shoots cull /mnt/incoming --dest /mnt/rejects --json >> /var/log/shoots.log 2>&1
```

### The develop refine loop has its own installer

Do not hand-write a crontab entry for `develop refine`. It needs a shoot path,
and which paths are still valid changes every time you move, re-edit or clean a
shoot — plus re-running it on an unchanged shoot is actively harmful (see
[`shoots schedule`](./commands/schedule.md#why-unchanged-is-skipped-and-why-it-matters)).
`shoots schedule install` registers one entry that resolves the paths at run time
and skips whatever has not changed, on cron and on the Windows Task Scheduler
alike:

```sh
shoots schedule install --at 02:30
shoots schedule status
```

---

## Watch folders

```sh
#!/usr/bin/env bash
# Poll an ingest folder; process anything that arrives.
set -euo pipefail

WATCH=/mnt/ingest
CATALOG=/mnt/catalog
REJECTS=/mnt/rejects

while true; do
  if [ -n "$(find "$WATCH" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    # Let a slow card finish writing
    sleep 30

    shoots import "$WATCH" --dest "$CATALOG" --move --json >> /var/log/shoots.log
    shoots cull "$CATALOG" --dest "$REJECTS" --json      >> /var/log/shoots.log
    shoots rate "$CATALOG" --profile wedding --write-xmp --json >> /var/log/shoots.log
  fi
  sleep 60
done
```

On Linux, `inotifywait` is a better trigger than polling. On macOS, `fswatch`.

---

## CI

### GitHub Actions

```yaml
name: ingest
on:
  workflow_dispatch:

jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - name: Install shoots
        run: curl -fsSL https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.sh | bash

      - name: Cache ~/.shoots
        uses: actions/cache@v4
        with:
          path: ~/.shoots
          key: shoots-tools-v1

      - name: Provision
        run: |
          shoots setup --json
          shoots doctor --json

      - name: Cull
        run: shoots cull ./incoming --dest ./rejects --json > cull.json

      - name: Gate on reject rate
        run: |
          rate=$(jq '.summary.blurry / .summary.total' cull.json)
          echo "reject rate: $rate"
          awk -v r="$rate" 'BEGIN { exit (r > 0.4) }' || {
            echo "::error::reject rate above 40%"; exit 1;
          }

      - uses: actions/upload-artifact@v4
        with:
          name: cull-report
          path: cull.json
```

Caching `~/.shoots` is the important bit — otherwise every run re-downloads
exiftool and the model.

---

## Windows / PowerShell

PowerShell has no `jq`, but `ConvertFrom-Json` is native:

```powershell
# The blurry frames
$report = shoots cull .\raw --json | ConvertFrom-Json
$report.results | Where-Object { $_.verdict -eq 'blurry' } | ForEach-Object { $_.file }

# Copy the 4+ star selects
$rated = shoots rate .\raw --profile wedding --json | ConvertFrom-Json
$rated.results |
  Where-Object { $_.stars -ge 4 } |
  ForEach-Object { Copy-Item $_.file -Destination .\selects\ }

# Star distribution
$rated.results | Group-Object stars | Select-Object Name, Count

# Gate on exit code
shoots import E:\DCIM --dest .\raw --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "import failed with $LASTEXITCODE" }
```

Note that PowerShell 5.1 has no `&&` / `||`; use `; if ($?) { ... }`.

---

## Error handling patterns

### Fail fast

```sh
set -euo pipefail
shoots import E:/DCIM --dest ./raw --json > import.json
shoots cull ./raw --dest ./rejects --json > cull.json
shoots rate ./raw --write-xmp --json > rate.json
```

### Tolerate partial failures, but record them

```sh
shoots import E:/DCIM --dest ./raw --json > import.json
code=$?

failed=$(jq '.summary.failed' import.json)
if [ "$failed" -gt 0 ]; then
  echo "warning: $failed files failed" >&2
  jq -r '.errors[] | "\(.source): \(.error)"' import.json >&2
fi

[ "$code" -le 1 ] || exit "$code"   # 2 = usage error, always fatal
```

### Distinguish usage errors from data errors

```sh
shoots rate ./raw --profile "$PROFILE" --json > rate.json
case $? in
  0) echo "all rated" ;;
  1) echo "some files failed — see .errors" >&2 ;;
  2) echo "configuration error: bad profile or missing model" >&2; exit 2 ;;
esac
```

---

## Performance

| Lever | Effect |
| --- | --- |
| `--concurrency <n>` | Default `4`. Raise for CPU-bound work (`cull`, `rate`) on many cores; lower on constrained machines. |
| `cull` before `rate` | Keeps expensive ML off frames you have already rejected. |
| `--edited-only` | On `develop export`, skips the expensive work on unedited files. Minutes instead of hours. |
| Cache `~/.shoots` | In CI, avoids re-downloading exiftool and the model on every run. |
| `shoots setup` up front | Moves the download out of the timed part of a pipeline. |

Raising `--concurrency` for `import` off a slow card rarely helps — the card is
the bottleneck.

---

## See also

- [Core concepts](./concepts.md) — the conventions this page relies on
- [Recipes](./recipes.md) — complete end-to-end workflows
- [Pipelines](./pipelines.md) — the declarative alternative to shell scripts
