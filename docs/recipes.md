# Recipes

Complete, copy-pasteable workflows for real shoots.

---

## 1. Wedding ingest — card to rated catalog

The full standard flow.

```sh
SHOOT=D:/Shoots/2026/smith-wedding

# ── 0. Sanity ─────────────────────────────────────────────────────────────────
shoots doctor

# ── 1. Offload both cards, checksum-verified ──────────────────────────────────
shoots import E:/DCIM/100CANON --dest "$SHOOT/raw" --dry-run   # look first
shoots import E:/DCIM/100CANON --dest "$SHOOT/raw"
shoots import F:/DCIM/100CANON --dest "$SHOOT/raw"             # second body merges in

# ── 2. Studio metadata on everything ──────────────────────────────────────────
shoots exif "$SHOOT/raw" \
  --set-artist "Jane Doe Photography" \
  --set-copyright "© 2026 Jane Doe Photography. All rights reserved." \
  --set-keywords wedding,smith,2026 \
  --set "XMP:City=Rome" \
  --set "XMP:Country=Italy"

# ── 3. Move the out-of-focus frames out of the way ────────────────────────────
shoots cull "$SHOOT/raw" --dest "$SHOOT/rejects" --dry-run     # look first
shoots cull "$SHOOT/raw" --dest "$SHOOT/rejects"

# ── 4. Star-rate the keepers, as XMP Lightroom will read ──────────────────────
shoots rate "$SHOOT/raw" --profile wedding --write-xmp

# ── 5. What survived? ─────────────────────────────────────────────────────────
shoots rate "$SHOOT/raw" --profile wedding --dry-run --json \
  | jq -r '.results[].stars' | sort | uniq -c
```

Then import `$SHOOT/raw` into Lightroom. Ratings and keywords are already there.

**Why this order:** metadata before culling (so rejects carry it too, in case you
restore one), and culling before rating (so the expensive ML never touches frames
you have already rejected).

---

## 2. Card offload with a rename scheme

When you want descriptive filenames instead of `IMG_0001`.

```sh
shoots import E:/DCIM/100CANON \
  --dest D:/Shoots/2026/smith-wedding/raw \
  --pattern "{date}_{time}_{camera}_{seq:4}.{ext}" \
  --dry-run
```

→ `20260719_143052_Canon-EOS-R5_0001.cr3`

Sequence numbers follow **capture order**, so two bodies interleave chronologically
into one clean sequence. Drop `--dry-run` when the plan looks right.

Already imported and want to rename after the fact:

```sh
shoots rename D:/Shoots/2026/smith-wedding/raw \
  --pattern "{date}_{seq:4}_{orig}.{ext}" --recursive --dry-run
```

Keeping `{orig}` means you can always trace a file back to the card.

---

## 3. Clearing a card safely

```sh
shoots import E:/DCIM --dest D:/Shoots/2026/smith-wedding --move --verbose
```

Each source file is deleted **only after** its copy's SHA-256 matches the source's.
A file that fails verification leaves its source untouched, has its corrupt copy
deleted, and is reported as an error.

Verify before reformatting:

```sh
shoots import E:/DCIM --dest ./raw --move --json > import.json
jq '.summary' import.json          # expect failed: 0
jq -r '.errors[]?' import.json     # expect empty
```

---

## 4. Tuning the cull threshold for a new body

Do not guess. Measure, then decide.

```sh
# 1. Report only, CSV
shoots cull ./raw --format csv --out scores.csv

# 2. Look at the softest frames
sort -t, -k2 -n scores.csv | head -30

# 3. Eyeball a handful at the boundary, decide where the line goes

# 4. Apply — dry run first
shoots cull ./raw --threshold 85 --dest ./rejects --dry-run
shoots cull ./raw --threshold 85 --dest ./rejects
```

For wide-open portrait work, also lower `--focus-threshold`:

```sh
shoots cull ./portraits --threshold 70 --focus-threshold 220 --dest ./rejects
```

For deep-DoF landscape work, the rescue rarely helps:

```sh
shoots cull ./landscape --threshold 130 --no-focus-rescue --dest ./rejects
```

---

## 5. Human-in-the-loop culling

When you want the machine to handle the obvious cases and hand you only the hard
ones. **Requires the interactive shell.**

```sh
shoots            # opens the shell
```

```
❯ /cd D:/Shoots/2026/smith-wedding
❯ /cull @raw/ --review --dest @rejects/ --dry-run    # learn the UI, touch nothing
❯ /cull @raw/ --review --dest @rejects/              # for real
```

Confident rejects are relocated immediately; you review only the uncertain
shallow-DoF rescues, with a focus heatmap showing where focus landed.
`K` keep · `D` discard · `P` preview · `S` skip · `Esc` finish.

---

## 6. Studio metadata as a versioned config

Keep a `studio-tags.yaml` under version control, next to your shoot scripts.

`studio-tags.yaml`:

```yaml
artist: "Jane Doe Photography"
copyright: "© 2026 Jane Doe Photography. All rights reserved."
keywords:
  - professional
  - jane-doe
XMP:CreatorWorkEmail: "hello@janedoe.photo"
XMP:CreatorWorkURL: "https://janedoe.photo"
IPTC:Credit: "Jane Doe Photography"
```

```sh
# Studio boilerplate + per-shoot keywords in one call
shoots exif ./raw --config studio-tags.yaml --set-keywords wedding,smith,2026
```

Command-line flags override file keys, so one config serves every shoot.

---

## 7. Building your own rating profile

The presets are priors. This makes the ratings actually yours.

```sh
# 1. Features from work you already know well
shoots embeddings ~/Pictures/street-2020-2026 --out ~/work/street-bundle

# 2. Build the duel tool
cd tools/match && npm install && npm run build

# 3. Import
node dist/cli.js import --data ~/work/street-bundle/embeddings.json --db ~/work/street.db

# 4. Duel ~600 pairs at http://127.0.0.1:4576, then Ctrl-C
node dist/cli.js serve --db ~/work/street.db

# 5. Train straight into the profiles directory
node dist/cli.js train --db ~/work/street.db \
  --name my-street-eye --out ~/.shoots/profiles/my-street-eye.json

# 6. Use it
shoots rate ~/Shoots/2026-07-rome --profile my-street-eye --write-xmp
```

Compare it against the built-in prior to see what you actually learned:

```sh
diff <(shoots rate ./sample --profile street        --dry-run --json | jq -r '.results[]|"\(.stars) \(.file)"') \
     <(shoots rate ./sample --profile my-street-eye --dry-run --json | jq -r '.results[]|"\(.stars) \(.file)"')
```

Full walkthrough: [Preference learning](./preference-learning.md).

---

## 8. Learning your develop style

```sh
# once, from a catalog you have already developed
shoots develop init ~/Catalogs/2025-edited

# per shoot — sidecars land next to the photographs, ready for Lightroom
shoots develop edit ~/Shoots/2026-07-new

# after developing them — close the loop: feedback + learn + calibrate
shoots develop refine ~/Shoots/2026-07-new --dry-run
shoots develop refine ~/Shoots/2026-07-new

# housekeeping
shoots develop status
shoots develop clean
```

`init` is `export --edited-only` + `train`; `edit` is `export` + `predict`. Both
accept `--dry-run` and every flag of the steps they wrap. `edit` will not
overwrite sidecars that already carry a real edit without `--force`.

Weak headline skill in the `init` report? Check whether the catalog holds several
distinct looks:

```sh
shoots develop diagnose --data ~/.shoots/develop/export/export.jsonl
```

---

## 9. Client proofs from a rated catalog

```sh
mkdir -p ./selects

shoots rate ./raw --profile wedding --json \
  | jq -r '.results[] | select(.stars >= 4) | .file' \
  | xargs -I{} cp {} ./selects/

# Client-facing names
shoots rename ./selects --pattern "SmithWedding_{seq:3}.{ext}"

# Strip internal keywords, keep the credit
shoots exif ./selects --set-keywords "smith-wedding-2026" --overwrite-original
```

---

## 10. Nightly watch folder

```sh
#!/usr/bin/env bash
set -euo pipefail

WATCH=/mnt/ingest
CATALOG=/mnt/catalog
REJECTS=/mnt/rejects
LOG=/var/log/shoots.log

shoots doctor --json >> "$LOG" || { echo "environment not ready" >&2; exit 1; }

[ -n "$(find "$WATCH" -mindepth 1 -maxdepth 1 -print -quit)" ] || exit 0

shoots import "$WATCH" --dest "$CATALOG" --move --json >> "$LOG"
shoots exif  "$CATALOG" --config /etc/shoots/studio-tags.yaml --json >> "$LOG"
shoots cull  "$CATALOG" --dest "$REJECTS" --json >> "$LOG"
shoots rate  "$CATALOG" --profile generic --write-xmp --json >> "$LOG"
```

```cron
SHOOTS_HOME=/opt/shoots-home
0 2 * * * /usr/local/bin/shoots-nightly.sh
```

Set `SHOOTS_HOME` explicitly — the cron user's home may differ from the one that
ran `setup`.

---

## 11. Auditing an existing archive

Read-only, non-destructive reconnaissance of a catalog you inherited.

```sh
# Which cameras and lenses?
shoots exif ./archive --json | jq -r '.files[].Model'     | sort | uniq -c | sort -rn
shoots exif ./archive --json | jq -r '.files[].LensModel' | sort | uniq -c | sort -rn

# What is missing copyright?
shoots exif ./archive --json \
  | jq -r '.files[] | select(.Copyright == null) | .SourceFile'

# How much of it is soft? (report only — nothing moves without --dest)
shoots cull ./archive --format csv --out archive-sharpness.csv

# What does the model think of it?
shoots rate ./archive --profile generic --dry-run --json \
  | jq -r '.results[].stars' | sort | uniq -c
```

None of these commands modify anything: `exif` in read mode, `cull` without
`--dest`, `rate` with `--dry-run`.

---

## 12. Portable field kit

Everything on an external drive, so a laptop swap costs nothing.

```sh
export SHOOTS_HOME=/Volumes/Field/shoots-home
shoots setup
shoots doctor
```

On the other machine, set the same variable and everything — tools, model,
learned profiles — is already there.

Add it to your shell profile to make it permanent:

```sh
echo 'export SHOOTS_HOME=/Volumes/Field/shoots-home' >> ~/.zshrc
```

---

## 13. Windows / PowerShell equivalent of recipe 1

```powershell
$SHOOT = "D:\Shoots\2026\smith-wedding"

shoots doctor
shoots import E:\DCIM\100CANON --dest "$SHOOT\raw" --dry-run
shoots import E:\DCIM\100CANON --dest "$SHOOT\raw"

shoots exif "$SHOOT\raw" `
  --set-artist "Jane Doe Photography" `
  --set-copyright "(c) 2026 Jane Doe Photography" `
  --set-keywords wedding,smith,2026

shoots cull "$SHOOT\raw" --dest "$SHOOT\rejects"
shoots rate "$SHOOT\raw" --profile wedding --write-xmp

# Star distribution
$rated = shoots rate "$SHOOT\raw" --profile wedding --dry-run --json | ConvertFrom-Json
$rated.results | Group-Object stars | Select-Object Name, Count
```

PowerShell 5.1 has no `&&` / `||` — use `; if ($?) { ... }` to chain
conditionally.

---

## See also

- [Scripting & automation](./scripting.md) — jq recipes, cron, CI, error handling
- [Command reference](./commands/README.md) — every flag
- [Troubleshooting](./troubleshooting.md) — when something goes wrong
