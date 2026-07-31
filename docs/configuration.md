# Configuration

`shoots` needs no configuration to work. Everything below is an override for
non-default setups: portable installs, air-gapped machines, CI images, forks.

---

## The shoots home

A single directory under the user's profile holds everything machine-local and
provisioned at runtime. It is `~/.shoots` on **every** OS — deliberately uniform,
so no environment variables need to be set on end-user machines.

```
~/.shoots/
├── bin/                          Downloaded external tools
│   ├── shoots(.exe)                the CLI binary itself (installer target)
│   ├── exiftool/13.59/             pinned version, checksum-verified
│   └── libraw/<version>/           dcraw_emu, the neutral RAW developer
├── models/
│   └── clip/vit-b32-int8-2/        clip-image-encoder.onnx
│                                   keywords.json
│                                   aesthetics.json
├── profiles/                     Your learned rating profiles (*.json)
├── match/                        Preference-learning duel databases
│   └── <profile>.db                every duel you have judged — not recomputable
├── develop/                      The develop predictor's own working files
│   ├── profile/export.json         your fitted style profile
│   ├── feedback.jsonl              every (predicted, kept) pair ever recorded
│   └── export/                     the training dataset, and one dir per shoot
│       └── shooting/<shoot>/         export.jsonl · prediction.json
│                                     refine-state.json (what `schedule` last saw)
├── cache/                        Regenerable: thumbnails, RAW previews
├── logs/
│   └── schedule.log                the daily `schedule run` transcript
└── config.json
```

On Windows the same tree lives at `%USERPROFILE%\.shoots`.

**`profiles/` is the one directory you write to yourself.** Drop a
`linear-embedding` profile JSON there (as emitted by `shoots match train`) and it becomes
selectable as `shoots rate --profile <filename-without-.json>`. See
[Rating profiles](./profiles.md).

**`develop/feedback.jsonl` is the one file that cannot be rebuilt at any price.**
It records what photographs looked like the day they were developed, and re-reading
them now cannot recover that. `develop clean` never touches it, `--all` or not.

Everything else is regenerable: delete the tree and `shoots setup` rebuilds the
tools and models, `develop init` the dataset and the profile.

---

## Environment variables

### Locations

| Variable | Default | Effect |
| --- | --- | --- |
| `SHOOTS_HOME` | `~/.shoots` | Relocate the entire home directory. Useful for portable installs, tests, and CI caches. |
| `SHOOTS_INSTALL_DIR` | `~/.shoots/bin` | **Installer only** — where the binary is placed. |

```sh
# Portable: keep everything on an external drive
export SHOOTS_HOME=/Volumes/Field/shoots-home
shoots setup
```

### External tools

| Variable | Effect |
| --- | --- |
| `SHOOTS_EXIFTOOL` | Path to an existing exiftool binary. Wins over the provisioned one — no download happens. |
| `SHOOTS_LIBRAW` | Path to an existing LibRaw `dcraw_emu` binary. |
| `SHOOTS_RAW_DEVELOPER` | An arbitrary RAW-developer executable for `develop export --baseline external`. Wins over the provisioned LibRaw. |
| `SHOOTS_RAW_DEVELOPER_ARGS` | Argument template for the above. `{in}` and `{out}` are substituted per file. |

```sh
# Use the system exiftool during development
export SHOOTS_EXIFTOOL=/usr/local/bin/exiftool

# Use RawTherapee with a neutral profile as the develop baseline
export SHOOTS_RAW_DEVELOPER=rawtherapee-cli
export SHOOTS_RAW_DEVELOPER_ARGS='-Y -q -o {out} -p neutral.pp3 -c {in}'
```

The default args already target `dcraw_emu`:
`-w -W -o 1 -q 0 -T -Z {out} {in}` — camera white balance, **no** auto-brighten
(so the true scene exposure survives), sRGB output, TIFF.

### Mirrors

| Variable | Effect |
| --- | --- |
| `SHOOTS_TOOLS_BASEURL` | Base URL for the exiftool / LibRaw archive mirror. |
| `SHOOTS_MODELS_BASEURL` | Base URL for the ONNX model archive mirror. |
| `SHOOTS_REPO` | GitHub `owner/repo` used by `shoots update` and the installers. Default `stefanopascazi/shoots`. |

Point these at an internal artifact server for an air-gapped or bandwidth-limited
studio. **Checksum verification still applies** — the pinned SHA-256 hashes live in
the binary, not in the mirror, so a hostile or corrupt mirror cannot substitute
content.

```sh
export SHOOTS_TOOLS_BASEURL=https://artifacts.studio.internal/shoots/tools
export SHOOTS_MODELS_BASEURL=https://artifacts.studio.internal/shoots/models
shoots setup
```

### Diagnostics

| Variable | Effect |
| --- | --- |
| `SHOOTS_DEBUG` | Print the full stack trace when an unexpected error escapes a command (see `packages/cli/src/crash.ts`). Off by default: batch output stays one readable `error:` line. |

### Build-time only

`SHOOTS_VERSION` and `SHOOTS_AUTHOR` are **not** runtime environment variables.
They are substituted into the bundle at build time (`packages/cli/tsup.config.ts`
and `scripts/build-binary.ts`) from the root `package.json`. Setting them in your
shell has no effect on an installed binary.

### GitHub API

| Variable | Effect |
| --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | Sent as a bearer token by `shoots update`. Raises the anonymous GitHub API rate limit — worth setting in CI. |

---

## Pinned versions

Current pins (they move with releases):

| Component | Version | Archive |
| --- | --- | --- |
| exiftool | `13.59` | `exiftool-13.59-win32.tar.gz` / `exiftool-13.59-unix.tar.gz` |
| CLIP model | `vit-b32-int8-2` | `clip-vit-b32-int8-2.tar.gz` |
| LibRaw | see `librawManifest()` | per-platform `dcraw_emu` |

Each is installed into a **version-scoped directory** (`bin/exiftool/13.59/`), so
upgrading `shoots` fetches the new version alongside the old rather than
clobbering it. `shoots doctor` reports what is actually resolved.

---

## Runtime prerequisites

| Requirement | Needed for | Notes |
| --- | --- | --- |
| `tar` | Extracting downloaded archives | Present by default on modern Windows 10+, macOS and Linux. |
| `perl` | Running exiftool on macOS/Linux | exiftool is a Perl distribution there. **Not** required on Windows, where exiftool is a native `.exe`. |

`shoots doctor` checks both.

---

## Working without external tools

`shoots` degrades rather than failing where it reasonably can:

| Situation | Behaviour |
| --- | --- |
| No exiftool, `import` with a template using `{camera}`/`{lens}` | Falls back to file mtime for dates; `{camera}`/`{lens}` render as `unknown-camera` / `unknown-lens`. The import still runs. |
| No exiftool, `cull` on a RAW folder | Fails — RAW scoring needs the embedded preview. |
| No exiftool, `cull` on JPEGs | Works. The aperture column is omitted (it is report context, not a decision input). |
| No exiftool, `exif` / `rename` | Fails with a clear message — those commands *are* exiftool. |
| No CLIP model | `rate`, `embeddings` and `develop export` fail with a message pointing at `shoots setup`. |
| No LibRaw and no `SHOOTS_RAW_DEVELOPER` | `develop export --baseline external` fails; `--baseline embedded-preview` (the default) still works. |
