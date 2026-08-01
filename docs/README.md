# shoots — documentation

Scriptable batch automation for professional photography workflows.

`shoots` is an **orchestration layer**, not an editor and not a DAM. It sits *before*
or *after* Lightroom / Capture One / your culling tool of choice and automates the
tedious parts around them.

---

## Start here

| Page | What it covers |
| --- | --- |
| [Getting started](./getting-started.md) | Install, `setup`, `doctor`, your first import |
| [Core concepts](./concepts.md) | Non-destructive rules, exit codes, JSON output, file discovery |
| [Command reference](./commands/README.md) | Every command, every flag, with examples |
| [Interactive shell](./shell.md) | The fullscreen `shoots` shell, `/` palette, `@` mentions |

## Guides

| Page | What it covers |
| --- | --- |
| [Filename templates](./templates.md) | The `{date}_{camera}_{seq:4}.{ext}` token language |
| [Rating profiles](./profiles.md) | Built-in profiles, how stars are decided, learned profiles |
| [Preference learning](./preference-learning.md) | `embeddings` → `match` duels → your own profile |
| [Develop predictor](./develop-predictor.md) | The local "Lightroom AI": learn your edit style, predict XMP |
| [Pipelines](./pipelines.md) | Declarative YAML pipelines (status: authorable, not yet executable) |
| [Scripting & automation](./scripting.md) | JSON, exit codes, cron, CI, watch folders |
| [Recipes](./recipes.md) | Complete end-to-end workflows for real shoots |

## Reference

| Page | What it covers |
| --- | --- |
| [Configuration](./configuration.md) | `~/.shoots` layout, every environment variable |
| [Migration notes](./migrations.md) | What each release asks of you — printed by `shoots release-notes` |
| [Troubleshooting](./troubleshooting.md) | Common failures and their fixes |
| [Development](./development.md) | Monorepo layout, build, release process |

---

## The 60-second tour

```sh
# 1. Install external tools (exiftool, LibRaw, the CLIP model) into ~/.shoots
shoots setup

# 2. Offload a card into a dated catalog, checksum-verified
shoots import E:/DCIM/100CANON --dest D:/Shoots/2026/smith-wedding

# 3. Stamp studio metadata onto everything
shoots exif D:/Shoots/2026/smith-wedding \
  --set-artist "Jane Doe Photography" \
  --set-copyright "© 2026 Jane Doe" \
  --set-keywords wedding,smith

# 4. Move the out-of-focus frames out of the way (keepers stay put)
shoots cull D:/Shoots/2026/smith-wedding --dest D:/Shoots/2026/smith-wedding/rejects

# 5. Star-rate what is left, as XMP sidecars Lightroom will read
shoots rate D:/Shoots/2026/smith-wedding --profile wedding --write-xmp
```

Every mutating command accepts `--dry-run`. Every command accepts `--json`.
Nothing is ever deleted.

---

## Command map

```
shoots
├── import       card → catalog, renamed and SHA-256 verified
├── rename       in-place batch rename with the same template engine
├── exif         batch read/write EXIF·IPTC·XMP via exiftool
├── cull         focus-aware blur detection; relocate or review rejects
├── rate         0–5 star ratings + keywords via the ONNX CLIP model
├── embeddings   profile-neutral CLIP export for preference learning
├── match        learn your eye from duels → a personal rating profile
│   ├── import      an embeddings bundle → the duel database
│   ├── serve       the duel UI at 127.0.0.1:4576
│   └── train       Bradley-Terry + ridge → ~/.shoots/profiles/<name>.json
├── develop      personal develop-setting predictor
│   ├── export      build a training dataset from an edited catalog
│   ├── train       fit a per-catalog develop profile
│   ├── predict     apply a profile → predicted crs vector / XMP sidecar
│   └── diagnose    style-clustering diagnostic
├── setup        provision exiftool + LibRaw + the inference model
├── doctor       environment health check
├── update       self-update the standalone binary
├── release-notes  the migration steps this release needs, checked against ~/.shoots
└── shell        the interactive shell (default with no arguments)
```

---

## License

Source-available, **not** open source — [PolyForm Noncommercial 1.0.0](../LICENSE).
Free to read, use, modify and share for noncommercial purposes only.
For a commercial license, contact stefanopascazi@gmail.com.
