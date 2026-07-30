<p align="center">
  <img src="assets/shoots.png" alt="shoots" width="128"/>
</p>

<h1 align="center">shoots</h1>

<p align="center">
  <b>Batch automation for professional photography workflows.</b><br/>
  A scriptable command-line tool that does the tedious work around your editor.
</p>

---

## What is it

`shoots` is a CLI for photographers who shoot a lot and edit in Lightroom, Capture One
or anything else. It is **not** an editor and **not** a catalog: it sits before and after
your editor and automates the boring parts of a shoot.

- **Offload and rename** a card into a dated catalog, checksum-verified.
- **Stamp metadata** (artist, copyright, keywords, any EXIF/IPTC/XMP tag) on a whole folder.
- **Cull the out-of-focus frames** with focus-aware blur detection — shallow depth of field
  included — with an optional human-in-the-loop review.
- **Star-rate and keyword** your images with a local AI model, written as XMP sidecars your
  editor reads.
- **Learn your taste**: train a rating profile on your own eye, and a predictor for your
  own develop settings.

Two rules never bend: **nothing is ever deleted or overwritten** (originals stay
untouched, edits go to sidecars), and **everything runs locally** — no cloud, no upload.
Every command speaks `--json` and honours `--dry-run`, so it drops straight into scripts,
cron and CI.

<p align="center">
  <img src="assets/screens/run.png" alt="A cull run in the shoots interactive shell" width="820"/>
</p>

## Getting started

Install the standalone binary — no Node.js required.

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.ps1 | iex
```

Or grab the binary for your platform from the
**[latest release](https://github.com/stefanopascazi/shoots/releases/latest)**.

Then:

```sh
shoots setup     # download the external tools and the AI model into ~/.shoots
shoots doctor    # check that everything is in place
shoots           # open the interactive shell (or use any command directly)
```

Your first import:

```sh
shoots import E:/DCIM/100CANON --dest D:/Shoots/2026/smith-wedding --dry-run
```

## Documentation

**[Read the guide →](./docs/README.md)**

[Getting started](./docs/getting-started.md) ·
[Core concepts](./docs/concepts.md) ·
[Command reference](./docs/commands/README.md) ·
[Interactive shell](./docs/shell.md) ·
[Recipes](./docs/recipes.md) ·
[Troubleshooting](./docs/troubleshooting.md) ·
[Development](./docs/development.md)

## License

**Source-available, not open source.** `shoots` is licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

You are free to read, use, modify, and share the source code — but **only for
noncommercial purposes**. Any commercial use of the software, in whole or in
part, is not permitted under this license.

Copyright © 2026 Stefano Pascazi. All commercial rights are reserved by the
copyright holder. For a commercial license, contact stefanopascazi@gmail.com.
