# `shoots setup`

Provision the external dependencies into `~/.shoots`: the exiftool binary, the
LibRaw RAW developer, and the ONNX CLIP inference model.

```
shoots setup [options]
```

---

## Options

| Option | Description |
| --- | --- |
| `--json` | Machine-readable JSON on stdout |
| `--verbose` | Verbose logging on stderr |

---

## What it provisions

| Dependency | Installed to | Needed by |
| --- | --- | --- |
| **exiftool** | `~/.shoots/bin/exiftool/<version>/` | `exif`, `rename`, `cull` (RAW), `rate --write-xmp`, `embeddings`, `develop export` |
| **LibRaw** (`dcraw_emu`) | `~/.shoots/bin/libraw/<version>/` | Anything on `--baseline external` — which is the **default** for `develop init` and `develop edit` |
| **CLIP model** (ONNX int8) | `~/.shoots/models/clip/<version>/` | `rate`, `embeddings`, `develop export` |

Each archive is downloaded from a mirror on GitHub Releases and verified against a
**SHA-256 pinned in the binary** — not supplied by the mirror. A corrupt or
substituted archive fails the check and is discarded.

---

## Why `setup` exists

Commands provision **lazily** on first use, so `setup` is never strictly required.
It exists to move the download to a predictable moment:

- an installer or first-run wizard,
- a CI image build, so pipeline runs don't each pay the download,
- a field laptop being prepared before losing connectivity,
- diagnosing a provisioning problem without a photo folder in the way.

It is **idempotent**: already-installed, checksum-verified dependencies are left
untouched. Safe to run every time.

---

## Examples

```sh
shoots setup
```

```
shoots home: C:\Users\jane\.shoots
exiftool: 13.59 ready
libraw: 0.21.4 ready
inference model: vit-b32-int8-2 ready
```

### Prepare an offline field kit

```sh
export SHOOTS_HOME=/Volumes/Field/shoots-home
shoots setup
shoots doctor
```

Everything now lives on the external drive; carry it and set `SHOOTS_HOME` on the
other machine.

### CI image

```dockerfile
RUN shoots setup --json > /tmp/setup.json && shoots doctor
```

### Behind an internal mirror

```sh
export SHOOTS_TOOLS_BASEURL=https://artifacts.studio.internal/shoots/tools
export SHOOTS_MODELS_BASEURL=https://artifacts.studio.internal/shoots/models
shoots setup
```

Checksum verification still applies — the pins live in the binary.

---

## JSON output

```json
{
  "command": "setup",
  "home": "C:\\Users\\jane\\.shoots",
  "tools": [
    {
      "name": "exiftool",
      "version": "13.59",
      "path": "C:\\Users\\jane\\.shoots\\bin\\exiftool\\13.59\\exiftool.exe",
      "ok": true
    },
    {
      "name": "libraw",
      "version": null,
      "path": null,
      "ok": false,
      "detail": "mirror not configured"
    },
    {
      "name": "inference model",
      "version": "vit-b32-int8-2",
      "path": "C:\\Users\\jane\\.shoots\\models\\clip\\vit-b32-int8-2",
      "ok": true
    }
  ]
}
```

---

## Partial failures

Not every dependency is fatal:

| Situation | Handling |
| --- | --- |
| **LibRaw mirror not configured** | **Warning**, not an error. Only the `external` baseline needs it, and `SHOOTS_RAW_DEVELOPER` can substitute. Exit code stays `0` — but note that baseline is what `develop init` and `develop edit` default to, so the develop predictor will fail later without one. |
| **Model mirror not configured** | **Warning**, not an error. Non-ML commands are unaffected. |
| **exiftool downloaded but not runnable** | **Error**, exit `1`. On macOS/Linux this almost always means Perl is missing — exiftool is a Perl distribution there. |
| **Download or checksum failure** | **Error**, exit `1`. |

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | Everything provisioned (warnings for unconfigured mirrors are tolerated) |
| `1` | A download, extraction, checksum or execution check failed |

---

## See also

- [`doctor`](./doctor.md) — verify what `setup` produced
- [Configuration](../configuration.md) — `SHOOTS_HOME`, mirrors, tool overrides
- [Troubleshooting](../troubleshooting.md) — when provisioning fails
