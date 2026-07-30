# Development

Building, testing and releasing `shoots` from source.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 20.9** | Enforced by the root `engines` field |
| **Bun** | Only for `npm run build:binary` (the single-binary build) |
| **Node ≥ 22.5** | Only for `tools/match` (it uses `node:sqlite`) |

`sharp` installs prebuilt libvips binaries automatically via npm. External tools
(exiftool, LibRaw) and the ONNX model are provisioned at runtime into `~/.shoots`,
not vendored into the repo.

---

## Monorepo layout

```
packages/
  cli/        Commander commands + Ink shell. The only package that knows about terminals.
  core/       Pipeline engine, templating, file discovery, job queue, checksums, provisioning, net.
  imaging/    exiftool wrapper, sharp thumbnails, Laplacian blur + focus-map analysis.
  inference/  QualityModel interface, ONNX CLIP backend, aesthetics, keywords, profiles.

tools/
  match/      Preference-learning duel tool. Deliberately OUTSIDE the workspaces.

scripts/
  build-binary.ts            Bun single-binary build (+ Windows executable metadata)
  generate-icon.ts           Application icon: assets/shoots.{svg,ico,png}
  capture-screens.tsx        Terminal screenshots: assets/screens/*.{png,svg}
  screens/                   ANSI emulator + SVG renderer + scene definitions
  prepare-tool-mirror.ts     exiftool archives for the mirror
  prepare-libraw-mirror.ts   LibRaw dcraw_emu, cross-built
  prepare-model-mirror.ts    CLIP ONNX archive + precomputed text embeddings

assets/       Brand assets: icon (.svg/.ico/.png) + screens/ screenshots, committed
examples/     Sample pipeline configs
docs/         This documentation
test/         Tests
```

### Dependency direction

```
cli → core, imaging, inference
imaging → core
```

`core`, `imaging` and `inference` **never** depend on `cli` or Ink. They are usable
headlessly, from a library, or from a future REST layer, unchanged. This is a hard
architectural rule, not a preference.

### Why `tools/match` is outside the workspaces

`shoots` is the feature extractor — the only place with CLIP and onnxruntime.
`match` only touches numeric embeddings and image files for its UI. Keeping it out
of `packages/*` keeps it off the CLI's dependency graph and out of the single
binary. It has its own `package.json` and its own build.

---

## Setup

```sh
npm install
npm run build          # builds core → imaging → inference → cli, in order
```

### Running the CLI in development

```sh
node packages/cli/dist/cli.js --help

# or the root convenience script
npm run shoots -- --help

# or link it globally
npm link -w @shoots/cli && shoots --help
```

### Watch mode

```sh
npm run dev -w @shoots/core       # tsup --watch, per package
npm run dev -w @shoots/imaging
npm run dev -w @shoots/inference
npm run dev -w @shoots/cli
```

### Type checking

```sh
npm run typecheck                 # tsc --noEmit per package
```

> **Build first.** `typecheck` needs cross-package `.d.ts` files to exist, so run
> `npm run build` before it on a clean checkout.

### Clean

```sh
npm run clean                     # removes every package's dist/
```

---

## Building the standalone binary

```sh
npm run build:binary              # bun scripts/build-binary.ts
```

Output lands in `dist-bin/`. The binary embeds `onnxruntime-node` (MIT) and
`sharp`'s native addons, which is why builds are **per-arch** — there is no
universal macOS build, and Intel macOS is not produced at all (no reliable Intel
CI runner).

### Executable identity

A Bun-compiled executable inherits Bun's own identity unless we replace it. How
much can be replaced depends entirely on the executable format:

| Target | Embeddable metadata | What we do |
| --- | --- | --- |
| Windows | PE resources (name, publisher, version, description, copyright, icon) | Stamped at build time — table below |
| Linux | none an OS or desktop reads: ELF has no resource section | Identity lives in the CLI itself and in packaging |
| macOS | none: an `Info.plist` needs an `.app` bundle, and Bun exposes no `__info_plist` section | Identity comes from the code signature |

Do **not** try to work around this with a post-processing pass — see the trap
below. On Linux and macOS the identity a user actually sees comes from
`--version` / `--help` (already ours), the man-page-and-packaging layer, and — on
macOS — signing:

- **macOS.** The Mach-O the compiler emits is well-formed for signing: the
  payload sits in a real `__BUN` segment, `LC_CODE_SIGNATURE` is present (Bun
  ad-hoc signs it) and there are **zero trailing bytes** after `__LINKEDIT`. So
  `codesign --sign "Developer ID Application: …"` + `notarytool` work on the
  release artifact as-is, which is what replaces Gatekeeper's "unidentified
  developer" with our name. Needs an Apple Developer membership; not wired up.
- **Linux.** `apt show` / `dnf info` fields (Maintainer, Homepage, License,
  Description) are where a Linux user reads whose product this is, so that
  identity arrives with `.deb`/`.rpm` packaging, not with the binary. Not wired
  up either: releases ship the raw binary plus `SHA256SUMS.txt`.

#### The post-processing trap

`objcopy`, `strip` and `patchelf` **silently destroy** a standalone binary. The
bundle is reachable through absolute file offsets held in a 166-byte `.bun`
section; any tool that rewrites the ELF shifts the layout, the offsets stop
resolving, and the executable degrades into **the plain Bun CLI** — with no
error and exit code 0:

```
$ objcopy --add-section .note.package=note.bin shoots shoots2   # e.g. systemd
$ ./shoots2 --version                                           # ELF metadata
1.3.14                                                          # ...Bun's
```

That is why the release workflow asserts the reported version *equals* the
package version instead of merely checking that `--version` runs: the naive
check passes on a gutted binary.

#### Windows PE resources

| PE field | Value | Source |
| --- | --- | --- |
| ProductName | `shoots` | `scripts/build-binary.ts` |
| CompanyName | author name | root `package.json` → `author` |
| FileDescription | product description | `packages/cli/package.json` → `description` |
| FileVersion / ProductVersion | `X.Y.Z.0` | root `package.json` → `version` |
| LegalCopyright | copyright + license | `LICENSE` (`Required Notice:`) + `license` |
| Icon | `assets/shoots.ico` | `npm run build:icon` |

Nothing here needs editing on a version bump. Verify a build with
`(Get-Item dist-bin\shoots.exe).VersionInfo` on Windows.

`assets/shoots.ico` (plus the `.svg` source and a 512px `.png` for docs) is
**committed**, and regenerated only when the mark changes:

```sh
npm run build:icon                # bun scripts/generate-icon.ts
```

Two things stay Bun's: the PE `InternalName` field, which its compiler does not
expose, and the "unknown publisher" warning in SmartScreen/UAC — that one is
about Authenticode signing, not metadata, and needs a code-signing certificate.

Runtime branding is covered separately: `packages/cli/src/crash.ts` claims
`uncaughtException` / `unhandledRejection` so a crash reports as `shoots`
instead of printing Bun's `Bun v1.x.y (…)` banner and `B:/~BUN/root/…` paths.
`SHOOTS_DEBUG=1` restores the stack trace.

---

## Screenshots

`assets/screens/` holds the terminal screenshots used by the README and the web
site, PNG (2x) and SVG, **committed**, with an auto-written
[index](../assets/screens/README.md). Regenerate them with:

```sh
npm run build                                      # the scenes spawn dist/cli.js
SHOOTS_SHOTS_SOURCE=/path/to/a/folder/of/raws \
  npm run build:screens                            # all scenes
npm run build:screens -- shell run --list          # a subset / list the scenes
```

Every image is a capture of **real** output, never hand-written text:
`scripts/capture-screens.tsx` either mounts the actual Ink component against a
fake TTY and types into it, or spawns the built CLI with colour forced on, then
replays the resulting ANSI stream through a small terminal emulator
(`scripts/screens/ansi.ts`) and draws the cell grid as an SVG window
(`scripts/screens/render.ts`) that sharp rasterises. A scene that cannot run —
no photographs to analyse, no shallow-DoF frame to review — is skipped rather
than faked.

Two rules keep the output machine-independent: every glyph is positioned in its
own cell (so a different monospace fallback cannot drift the layout), and block,
box-drawing and braille characters are drawn as geometry rather than type
(`scripts/screens/glyphs.ts`), so they tile the way a terminal tiles them.

Scenes that analyse photographs need real files: point `SHOOTS_SHOTS_SOURCE` at
a folder of RAW/JPEGs (default `test/Raw`) and the script stages a handful into
`demo/` (gitignored, deleted afterwards unless `SHOOTS_SHOTS_KEEP_DEMO=1`).

---

## Conventions

These are enforced by review, and some by code.

### Output

- **stdout** carries the command result (human table or `--json`).
- **stderr** carries every log, warning and progress indicator.
- Exit codes: `0` ok, `1` per-file failures, `2` bad usage.

Use the helpers in `packages/cli/src/io.ts` (`printHuman`, `printJson`,
`logError`, `logWarn`, `logVerbose`, `markFailure`) rather than writing to the
streams directly.

### Every CLI command lives in the shell

`packages/cli/src/shell/catalog.ts` holds the shell's command catalog, and
`assertShellCatalogInSync(program)` runs at **every startup**. A command
registered on the CLI but missing from the catalog — or vice versa — throws with
a precise diff.

Adding a command therefore means:

1. `packages/cli/src/commands/<name>.ts` exporting `register<Name>Command`,
2. registering it in `packages/cli/src/cli.tsx`,
3. adding a `CommandSpec` to `COMMANDS` in `shell/catalog.ts`,
4. a page under `docs/commands/`.

Skipping step 3 fails loudly the moment any command runs.

### Code structure

- **No monolithic files.** Separate UI components, service wiring and reusable
  logic into dedicated modules and folders.
- **In React renderers**, prefer separate components and reusable hooks/services
  over accumulating JSX, state management and utilities in one file.
- **Comments in English**, and only where they clarify non-obvious logic.
- **UI text in English**, always.

### Licensing rule

> **Every external dependency must be commercially redistributable.**

Every runtime dependency, third-party binary and model must carry a license
permitting commercial use and redistribution (MIT, BSD, Apache-2.0, or
Artistic/GPL for binaries executed as an external process). **Verify the license
before introducing a dependency**; when in doubt, discard it and find an
alternative.

This is why:

- the aesthetic path is **zero-shot CLIP (MIT)** rather than an AVA-trained
  aesthetic scorer — AVA-derived weights are not commercially clean;
- exiftool and LibRaw are executed as **external processes**, not linked;
- `onnxruntime-node` (MIT) is embedded in the binary, which is fine.

### Git

- **Never create new branches.**
- Commit with `git add` + `git commit` and a coherent message.
- Commit messages follow **semantic release** (`feat:`, `fix:`, `chore:`, `ci:`,
  `docs:`, …).
- **Never include a signature** in commits or commit descriptions.

---

## External dependency provisioning

Runtime dependencies are downloaded into `~/.shoots`, verified against a SHA-256
**pinned in the source**, from a mirror on GitHub Releases.

| Component | Manifest | Mirror script |
| --- | --- | --- |
| exiftool | `packages/imaging/src/tools/exiftoolManifest.ts` | `scripts/prepare-tool-mirror.ts` |
| LibRaw | `packages/imaging/src/tools/librawManifest.ts` | `scripts/prepare-libraw-mirror.ts` |
| CLIP model | `packages/inference/src/models/clipManifest.ts` | `scripts/prepare-model-mirror.ts` |

Provisioning logic is shared in `packages/core/src/provision.ts` and
`packages/core/src/net/download.ts`.

### Bumping a pinned version

1. Update the version constant in the manifest.
2. Run the corresponding `prepare-*-mirror.ts` script to build the archives.
3. Upload them to the mirror release.
4. Paste the resulting SHA-256 values into the manifest.
5. `shoots doctor` should report the new version as pinned and provisioned.

Checksums accept an optional `sha256:` prefix.

### The model archive

`prepare-model-mirror.ts` builds `clip-<version>.tar.gz` containing:

| File | Contents |
| --- | --- |
| `clip-image-encoder.onnx` | The int8 image encoder |
| `keywords.json` | Keyword vocabulary with **precomputed text embeddings** |
| `aesthetics.json` | Aspect prompt pairs with precomputed text embeddings |

Text embeddings are computed **once, offline**. That is why the runtime needs no
text encoder and no tokenizer — only the image encoder plus cosine similarity.

Adding or changing an aspect means regenerating the archive and bumping
`CLIP_MODEL_VERSION`, because the embedding space that learned profiles are pinned
to must stay stable.

---

## Release process

Version lives in **one place**: the root `package.json`. Releases are **tag-only**;
the changelog is generated by `git-cliff` (`cliff.toml`).

```sh
npm version patch      # or minor / major
```

That triggers:

- `preversion` → `npm run typecheck && npm run build`
- the version bump and commit
- `postversion` → `git push origin main && git push origin --tags`

CI builds the per-platform binaries, generates `SHA256SUMS.txt`, and publishes the
GitHub release. `shoots update` and both installers consume that release.

---

## `tools/match`

Its own project, its own build:

```sh
cd tools/match
npm install
npm run dev -- import --data ../../bundle/embeddings.json   # from source, via tsx
npm run build && npm start -- serve                          # compiled
```

| | |
| --- | --- |
| Requires | **Node ≥ 22.5** (for `node:sqlite`) |
| Runtime deps | `express`, `commander` — both MIT |
| Storage | `node:sqlite`, built in — no native build |
| Never loads | onnxruntime |

See [Preference learning](./preference-learning.md).

---

## Testing changes end to end

The project rule is: **always verify the end-to-end flow.** A change that
type-checks is not a change that works.

```sh
npm run build

# A real folder, dry-run first
node packages/cli/dist/cli.js import ./test/fixtures --dest /tmp/out --dry-run
node packages/cli/dist/cli.js cull ./test/fixtures --format csv
node packages/cli/dist/cli.js rate ./test/fixtures --dry-run
node packages/cli/dist/cli.js doctor

# The shell (needs a TTY)
node packages/cli/dist/cli.js
```

Use an isolated home so you do not disturb your real one:

```sh
SHOOTS_HOME=/tmp/shoots-test node packages/cli/dist/cli.js setup
```

---

## License

**Source-available, not open source** —
[PolyForm Noncommercial 1.0.0](../LICENSE).

Read, use, modify and share for **noncommercial purposes** only. All commercial
rights are reserved by the copyright holder. Contributions require a CLA. For a
commercial license, contact stefanopascazi@gmail.com.

`tools/match` and `packages/cli/src/develop` inherit the same license.
