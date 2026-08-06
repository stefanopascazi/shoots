# Troubleshooting

**Start here:**

```sh
shoots doctor
```

It checks the home directory, the archive extractor, the exiftool runtime
prerequisites, the mirrors, and every provisioned dependency. Most problems on
this page show up there first.

---

## The CLI looks hung

### No output for minutes, but disk or network activity is high

**This is almost always normal.** Every batch command spends its first stage
walking directories and batch-reading metadata, before there is anything to count.
On a large or network-mounted catalog that stage dominates the wall-clock time.

You should see a phase line with an advancing elapsed counter:

```
⠹ Reading capture metadata 1500/8420 — 96.4s
```

If the counter is advancing, it is working. Scanning costs one round-trip per
directory entry, and the metadata pass opens every file to read its headers —
against an SMB share, a few thousand RAWs is routinely minutes of sustained
traffic with no other symptom.

See [Progress and the startup phases](./concepts.md#6-progress-and-the-startup-phases).

### `develop refine` or `develop train` sits there with the CPU pinned

Also normal, and the longest wait the tool has. Every refit re-chooses each
parameter's λ against held-out shoots over the **whole** catalog — not just the
frames you have just folded in — for both the level and the frame head. Several
hundred photographs is several minutes.

`refine` reaches it in its second step, and says so:

```
═══ [2/3] Learning from it ═══
…
Refitting the profile on all 556 images → ~/.shoots/develop/profile/export.json
████████░░░░░░░░░░░░░░░░  33%  Fitting the profile · color frame · tone · gate — 2m05s, ~4m10s left
```

If the bar is advancing, wait for it. If you want the dataset updated without
paying for the refit, `develop learn --no-train` stops before it.

Should the CLI ever finish its output and still not return, run it again with
`SHOOTS_DEBUG_EXIT=1`: it prints what was still alive at exit, which is the one
thing needed to diagnose it.

### No phase lines at all

Phases render on stderr, and only when appropriate:

| Context | Expected |
| --- | --- |
| Terminal, no `--json` | Animated spinner |
| Piped / cron / CI | Plain lines, **only with `--verbose`** |
| `--json` | Nothing, by design — stdout must stay clean |

If you piped stderr away (`2>/dev/null`), you removed them. If you are in a pipe,
add `--verbose`.

### Speeding up the startup stage

| Lever | Effect |
| --- | --- |
| `--edited-only` on `develop export` | Skips the expensive pass on files with no develop settings. Often the difference between hours and minutes. |
| Point at a narrower subtree | Scanning a dated subfolder beats scanning the whole catalog. |
| Work from a local copy | For repeated runs over a NAS, one `shoots import` then local processing wins. |
| `--no-recursive` on `exif` | Limits the walk to one directory level. |

---

## Installation

### `shoots: command not found`

The installer added `~/.shoots/bin` to your `PATH`, but the current shell was
started before that.

```sh
# Restart the shell, or:
export PATH="$HOME/.shoots/bin:$PATH"      # bash/zsh
```

```powershell
$env:PATH = "$env:USERPROFILE\.shoots\bin;$env:PATH"   # this session
```

Make it permanent by adding it to `~/.bashrc` / `~/.zshrc`, or on Windows via
System Properties → Environment Variables.

### The installer fails to write

Installing to a system directory needs elevation:

```sh
SHOOTS_INSTALL_DIR=/usr/local/bin curl -fsSL https://…/install.sh | sudo bash
```

Or just use the default `~/.shoots/bin`, which needs no privileges.

### No release asset for this platform

Supported targets: `windows-x64`, `linux-x64`, `linux-arm64`, `darwin-arm64`.

**Intel macOS (`darwin-x64`) is not built** — there is no reliable Intel CI runner,
and the Bun binary embeds per-arch native addons, so no universal build is
possible. On Intel Macs, build from source ([Development](./development.md)).

---

## Provisioning

### `exiftool: not provisioned — run 'shoots setup'`

A **warning**, not an error. Commands provision lazily on first use. Run
`shoots setup` if you would rather do it up front.

### `exiftool was installed but could not be executed`

Almost always **missing Perl on macOS/Linux** — exiftool is a Perl distribution
there. (On Windows it is a native `.exe` and Perl is irrelevant.)

```sh
# Debian/Ubuntu
sudo apt install perl

# macOS — Perl ships with the system; if it is missing:
brew install perl
```

Verify:

```sh
perl -e 'print $^V'
shoots doctor
```

### `tar: not found`

Needed to extract downloaded archives. Present by default on Windows 10+, macOS
and modern Linux.

```sh
sudo apt install tar        # Debian/Ubuntu
sudo dnf install tar        # Fedora/RHEL
```

### `mirror not configured`

The pinned checksum for that component is not published yet — expected during
development for LibRaw and, occasionally, the model.

| Component | Impact | Workaround |
| --- | --- | --- |
| LibRaw | Only `develop export --baseline external` | Set `SHOOTS_RAW_DEVELOPER` to a local RAW developer |
| Model | `rate`, `embeddings`, `develop export` | None — wait for the mirror |

This is a warning in `setup` and `doctor`; the exit code stays `0`.

### Checksum verification failed

The downloaded archive does not match its pinned SHA-256. Usually a truncated
download or a proxy that rewrote the body.

```sh
rm -rf ~/.shoots/bin ~/.shoots/models
shoots setup --verbose
```

If it persists behind a corporate proxy, host the archives internally and point
`SHOOTS_TOOLS_BASEURL` / `SHOOTS_MODELS_BASEURL` at them. Verification still
applies — the pins live in the binary, so an internal mirror cannot substitute
content.

### `shoots home not writable`

```sh
ls -ld ~/.shoots
chmod u+rwx ~/.shoots
```

Or relocate it:

```sh
export SHOOTS_HOME=/path/you/can/write
shoots setup
```

In cron or a service account, `SHOOTS_HOME` may resolve to a different user's home
than the one you ran `setup` under. Set it explicitly in the crontab.

---

## Import

### `Checksum mismatch after copy`

The copy did not match the source. `shoots` deleted **its own corrupt copy** — your
source file is untouched.

Causes, in order of likelihood: a failing card or reader, a flaky USB connection,
a full or failing destination drive.

```sh
# Retry just that file
shoots import E:/DCIM/100CANON/IMG_0042.CR3 --dest ./raw --verbose
```

Repeated mismatches on the same file mean the source is likely damaged. Try a
different reader before concluding the card is bad. **Never run `--move` on a card
that is producing mismatches.**

### `Destination already exists, refusing to overwrite`

`shoots` never overwrites. Normally collisions get `_2`, `_3` suffixes
automatically; this specific error means something else wrote the destination
concurrently.

Check for another `shoots` process or a sync client (Dropbox, OneDrive) touching
the destination.

### Dates are wrong / files landed in `nodate` folders

EXIF was unavailable and mtime was used, or the files carry no usable date.

```sh
# Which files guessed?
shoots import E:/DCIM --dest ./raw --json | jq -r '.files[] | select(.dateSource=="mtime") | .source'

# Is exiftool working?
shoots doctor
```

If exiftool is fine but dates are still wrong, check whether the source files
actually carry `DateTimeOriginal`:

```sh
shoots exif E:/DCIM --tags DateTimeOriginal --json | jq '.files[0]'
```

### `{camera}` renders as `unknown-camera`

exiftool could not be provisioned, or the file carries no `Model` tag.

`import` degrades deliberately rather than aborting. `rename` does not — it
requires exiftool.

---

## Cull

### Everything is classified as blurry

The threshold is too high for this camera/lens/subject combination. Thresholds
are **not** universal.

```sh
shoots cull ./raw --format csv --out scores.csv
sort -t, -k2 -n scores.csv | head -30
```

Look at the actual distribution, then pick a threshold that puts the boundary
where you would put it. See [recipe 4](./recipes.md#4-tuning-the-cull-threshold-for-a-new-body).

### Sharp shallow-DoF portraits are marked blurry

That is exactly what the focus rescue exists to prevent — so it is probably
disabled or set too high.

```sh
# Do not pass --no-focus-rescue for this kind of work
shoots cull ./portraits --threshold 70 --focus-threshold 200
```

Frames rescued this way show as `sharp*` with `rescued: true`.

### `--review needs the interactive shell`

`--review` drives a live UI, so it only works inside the shell:

```sh
shoots                                   # opens the shell
```
```
❯ /cull ./raw --review --mark
```

It needs `--mark` (record the verdicts, move nothing) or `--dest <dir>`
(relocate the rejects) — a review has to know what a discard means.

Every other flag works identically in batch.

### `--out points to a directory, not a file`

`--out` names a report **file**:

```sh
shoots cull ./raw --format csv --out ./reports/cull.csv     # not ./reports/
```

### RAW files fail to analyze

RAW scoring uses the embedded JPEG preview, extracted with exiftool.

```sh
shoots doctor        # is exiftool ok?
```

A RAW with no embedded preview (rare, mostly older or unusual formats) cannot be
scored and is reported as an error.

---

## Rate / embeddings

### `unknown rating profile 'x'`

The error lists every available name — built-ins plus everything in
`~/.shoots/profiles`:

```
error: unknown rating profile 'foo' (available: street, generic, portrait, wildlife, wedding, my-eye)
```

A learned profile must be at `~/.shoots/profiles/<name>.json`. Built-in names win
over user profiles, so do not name yours `street`.

### `invalid profile my-eye.json: …`

Learned profiles are validated field by field before use, so a malformed one fails
loudly rather than producing silent garbage stars.

| Message | Meaning |
| --- | --- |
| `weights must be 512 finite numbers` | `weights` length does not match `dim`, or contains non-finite values |
| `unsupported type 'x' (expected 'linear-embedding')` | Wrong profile kind |
| `aestheticStars must be a non-empty list of { min:number, stars:0–5 }` | Malformed cut-offs |

Re-run `shoots match train` to regenerate it.

### `XMP sidecar already exists, refusing to overwrite`

Deliberate — your existing edits are never clobbered.

```sh
# Inspect what is there, then decide
ls ./raw/*.xmp

# If you really want to re-rate, move the old ones aside
mkdir ./xmp-backup && mv ./raw/*.xmp ./xmp-backup/
shoots rate ./raw --profile wedding --write-xmp
```

### Ratings look far too harsh

Expected with the default `street` profile — it is deliberately unforgiving, and
on a real shoot the mass of frames legitimately lands at 0–1 stars.

Try a forgiving profile:

```sh
shoots rate ./raw --profile generic --dry-run
shoots rate ./raw --profile wedding --dry-run
```

The real fix is [training your own profile](./preference-learning.md). Only
`street` is calibrated; the rest are priors.

### Out of memory / very slow

ONNX inference holds real memory per parallel job.

```sh
shoots rate ./raw --concurrency 2
```

Also run `cull` first — moving rejects out keeps the expensive ML step off frames
you have already discarded.

---

## Develop

### Headline skill is near zero

In order of impact:

1. **Check the baseline.** `embedded-preview` bakes in the camera's picture
   style; `external` gives a neutral render, and it is the single largest lever.
   `develop init` already defaults to `external`, so this applies to a dataset
   built by hand with `develop export`, or one exported before that default
   changed — `develop status` says which yours carries.
2. **Run `develop diagnose`.** If clustered skill clearly beats pooled skill, your
   catalog holds several distinct looks and one pooled model is averaging them
   into mush. Split the catalog.
3. **More edited images.** Ridge over hundreds of parameters needs a real catalog.
4. **Check consistency.** If you genuinely edit every image on its own terms,
   there may be no style to learn — a legitimate finding, not a bug.

Full guidance: [Develop predictor](./develop-predictor.md#when-the-result-is-weak).

### Every frame in a shoot gets the same prediction

Read the **`in-shoot`** column of `develop train`, and the `within-shoot skill`
in the branch header. A healthy headline with `in-shoot` near zero means the model
has learned your shoots rather than your photographs, and the headline cannot
show that on its own.

If in-shoot skill is real but the predictions still barely move, the model is
being timid rather than blind: raise `--boldness` (0 → 1) and `--anchor-gain`, and
judge the result in your editor — the skill scores fall as boldness rises, by
design. `develop calibrate --review` sets that intensity by eye, without a refit.

### `baseline "external" needs a RAW developer`

```sh
shoots setup                                   # provisions LibRaw
# …or point at your own
export SHOOTS_RAW_DEVELOPER=dcraw_emu
export SHOOTS_RAW_DEVELOPER_ARGS='-w -W -o 1 -q 0 -T -Z {out} {in}'
```

`dcraw_emu` needs **LibRaw ≥ 0.20** for CR3 support.

### `profile color dim 44 != dataset color dim 50`

Your profile predates a release that widened the feature vector; it is stale, not
broken. Ask what is outstanding, then rebuild:

```sh
shoots release-notes
shoots develop init <your-edited-catalog>
```

`develop refresh-targets` does not help — the features changed, not the targets.
See [Migration notes](./migrations.md).

### The dataset is empty

Almost always `--edited-only` on a folder with no develop settings.

```sh
# Training set from an EDITED catalog — --edited-only is correct
shoots develop export ~/Catalogs/2025-edited --edited-only --out train.jsonl

# New, unedited shoot — do NOT use --edited-only
shoots develop export ~/Shoots/2026-07-new --out new.jsonl
```

### Results look suspiciously good on a DNG catalog

Possible **target leak**. A DNG whose preview was updated by the editor bakes the
edit into the "before" render, so the model appears to work while having learned
nothing.

Proprietary RAW (CR3/NEF/ARW) is safe — the embedded preview is the camera JPEG,
edit-independent. For DNG, verify the previews or use `--baseline external`.

---

## Shell

### `the interactive shell needs a terminal (TTY)`

The shell needs a TTY on **both** stdin and stdout. It cannot run in a pipe, a
cron job or most CI runners.

```sh
shoots --help     # batch usage
```

### Cannot select or copy text

Mouse capture is on — the alternate screen buffer disables native scrolling, so
the shell captures the wheel to provide its own scrollback. While captured, the
terminal never sees your drag.

```
❯ /mouse        # toggle capture off → select and copy normally
❯ /mouse        # toggle it back on
```

### The terminal looks broken after an exit

It should not — alt-screen and mouse mode are torn down on exit including on
crash. If something external killed the process hard:

```sh
reset           # bash/zsh
```

---

## Update

### `only works on the standalone binary, not when run via node/bun`

You are running from a source checkout. Use git instead:

```sh
git pull && npm run build
```

### `Could not check for updates: GitHub API 403`

Anonymous GitHub API rate limit.

```sh
GITHUB_TOKEN=ghp_… shoots update --check
```

### Permission denied during the swap

`update` replaces the running executable, so it needs write access to that
directory.

```sh
sudo shoots update              # for /usr/local/bin installs
```

The default `~/.shoots/bin` needs no elevation.

### `shoots.exe.old` left behind on Windows

Normal and harmless. A running `.exe` cannot be deleted, so the old binary is
renamed aside and cleaned up best-effort; it disappears on the next run.

---

## Getting more detail

```sh
# Verbose diagnostics on stderr
shoots <command> --verbose

# Machine-readable, with a full errors array
shoots <command> --json | jq '.errors'

# Full environment state
shoots doctor --json
```

When reporting a problem, include the output of `shoots doctor --json` and the
failing command with `--verbose`.
