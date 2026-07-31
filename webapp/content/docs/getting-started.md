# Getting started

## 1. Install

`shoots` ships as a **standalone binary** — no Node.js runtime required on the
target machine.

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.ps1 | iex
```

The installer:

1. detects your OS/arch and picks the matching release asset,
2. downloads it and verifies its SHA-256 against the release `SHA256SUMS.txt`,
3. installs to `~/.shoots/bin` (`%USERPROFILE%\.shoots\bin` on Windows),
4. adds that directory to your `PATH`.

**Installer variables**

| Variable | Effect |
| --- | --- |
| `SHOOTS_INSTALL_DIR` | Install somewhere other than `~/.shoots/bin` |
| `SHOOTS_REPO` | Point at a fork / mirror repository |

```sh
SHOOTS_INSTALL_DIR=/usr/local/bin \
  curl -fsSL https://raw.githubusercontent.com/stefanopascazi/shoots/main/install.sh | bash
```

Both installers always fetch the **latest** release. To install a specific
version, download that release's asset directly from GitHub.

Supported release targets: `windows-x64`, `linux-x64`, `linux-arm64`,
`darwin-arm64`. Intel macOS (`darwin-x64`) is intentionally not built.

### Building from source

See [Development](./development.md).

---

## 2. Provision the external dependencies

`shoots` does **not** bundle third-party binaries or ML models. They are
downloaded at runtime into `~/.shoots`, verified against pinned SHA-256 hashes,
from a mirror on GitHub Releases.

```sh
shoots setup
```

This fetches, in order:

| Dependency | Why | Used by |
| --- | --- | --- |
| **exiftool** | metadata read/write, RAW embedded-preview extraction | `exif`, `rename`, `cull` (RAW), `rate --write-xmp`, `embeddings`, `develop export` |
| **LibRaw** (`dcraw_emu`) | neutral, camera-independent RAW render | `develop export --baseline external` |
| **CLIP model** (ONNX, int8) | image embeddings, aesthetics, keywords | `rate`, `embeddings`, `develop export` |

`setup` is **idempotent** — already-installed, checksum-verified dependencies are
left untouched, so it is safe to run from an installer or a CI image.

You can skip it: every command provisions lazily on first use. `setup` just moves
that download to a predictable moment.

---

## 3. Verify the environment

```sh
shoots doctor
```

```
[✓] platform     win32/x64, node v22.11.0
[✓] shoots home  C:\Users\jane\.shoots (writable)
[✓] tar          bsdtar 3.7.2
[✓] perl         not required on Windows (exiftool is native)
[✓] tool mirror  https://github.com/stefanopascazi/shoots/releases/download/tools-v1
[✓] exiftool     13.59 (C:\Users\jane\.shoots\bin\exiftool\13.59\exiftool.exe)
[✓] libraw       C:\Users\jane\.shoots\bin\libraw\0.21.4\dcraw_emu.exe
[✓] inference model  vit-b32-int8-2 (C:\Users\jane\.shoots\models\clip\vit-b32-int8-2)
[✓] sharp        libvips 8.15.3

9 checks: 9 ok, 0 warnings, 0 failed
```

`doctor` exits `1` if any check **fails**; warnings (a dependency merely not
provisioned yet) do not fail the command. Full details in
[`doctor`](./commands/doctor.md).

---

## 4. Your first import

Always start with `--dry-run`. It shows the exact plan without touching a byte.

```sh
shoots import E:/DCIM/100CANON --dest D:/Shoots/2026/smith-wedding --dry-run
```

```
copy  E:\DCIM\100CANON\IMG_0001.CR3  →  D:\Shoots\2026\smith-wedding\2026\2026-07-19\IMG_0001.CR3
copy  E:\DCIM\100CANON\IMG_0002.CR3  →  D:\Shoots\2026\smith-wedding\2026\2026-07-19\IMG_0002.CR3
...
(dry run) 482 files would be copied to D:\Shoots\2026\smith-wedding
```

Note two defaults:

- **Original filenames are kept.** Renaming is opt-in (`--rename` for the default
  template, `--pattern` for your own). Your camera's `IMG_0001` numbering is
  meaningful to you; `shoots` does not throw it away unless asked.
- **Files land in `{year}/{year}-{month}-{day}` subfolders** — a Lightroom-style
  catalog layout. Use `--flat` to disable, or `--dir` for a custom layout.

Happy with the plan? Drop `--dry-run`:

```sh
shoots import E:/DCIM/100CANON --dest D:/Shoots/2026/smith-wedding
```

```
ok    E:\DCIM\100CANON\IMG_0001.CR3  →  D:\Shoots\2026\smith-wedding\2026\2026-07-19\IMG_0001.CR3  [sha256 verified]
...

482/482 files copied to D:\Shoots\2026\smith-wedding
```

Every copy is SHA-256 verified against its source. A mismatch fails loudly and
deletes the **corrupt copy** — never the source.

---

## 5. Explore interactively

Run `shoots` with no arguments on a terminal:

```
  ███████╗██╗  ██╗ ██████╗  ██████╗ ████████╗███████╗
  ██╔════╝██║  ██║██╔═══██╗██╔═══██╗╚══██╔══╝██╔════╝
  ███████╗███████║██║   ██║██║   ██║   ██║   ███████╗
  ╚════██║██╔══██║██║   ██║██║   ██║   ██║   ╚════██║
  ███████║██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████║
  ╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝
  ◉ v0.4.1 — batch automation for photographers

❯ /cull @raw/ --dest @rejects/ --review
```

Type `/` for the command palette, `@` to autocomplete paths. See
[Interactive shell](./shell.md).

---

## Where to go next

- Automating a studio? → [Recipes](./recipes.md) and [Scripting](./scripting.md)
- Want ratings that match *your* eye? → [Preference learning](./preference-learning.md)
- Want a develop starting point per image? → [Develop predictor](./develop-predictor.md)
- Something broken? → [Troubleshooting](./troubleshooting.md)
