# `shoots doctor`

Environment health check: shoots home, external tools, their runtime
prerequisites, and the native imaging stack.

```
shoots doctor [options]
```

---

## Options

| Option | Description |
| --- | --- |
| `--json` | Machine-readable JSON on stdout |
| `--verbose` | Verbose logging on stderr |

---

## The checks

Run in order:

| Check | Verifies | Fails when |
| --- | --- | --- |
| `platform` | OS, architecture, Node version | never (informational) |
| `shoots home` | The home directory exists and is **writable** (probe write + delete) | not writable |
| `tar` | `tar` is on `PATH` — needed to extract downloaded archives | not found |
| `perl` | Perl is available (exiftool is a Perl distribution on macOS/Linux) | not found on macOS/Linux. Always `ok` on Windows, where exiftool is native. |
| `tool mirror` | The exiftool mirror has a pinned SHA-256 | warns when unpinned |
| `exiftool` | Resolvable **and executable**; reports the version | resolved but not runnable |
| `libraw` | A RAW developer is available — `SHOOTS_RAW_DEVELOPER` wins, else the provisioned binary | warns only |
| `inference model` | The CLIP model archive is pinned and provisioned | warns only |
| `sharp` | The native imaging stack loads; reports the libvips version | never in practice |

### Status symbols

| Symbol | Status | Effect on exit code |
| --- | --- | --- |
| `✓` | ok | none |
| `!` | warn — something optional is missing or unconfigured | none |
| `✗` | fail — something required is broken | exit `1` |

The distinction matters: a dependency that is merely **not provisioned yet** is a
warning, because commands provision lazily. A dependency that is present but
**broken** is a failure.

---

## Examples

### Healthy machine

```sh
shoots doctor
```

```
[✓] platform     win32/x64, node v22.11.0
[✓] shoots home  C:\Users\jane\.shoots (writable)
[✓] tar          bsdtar 3.7.2 - libarchive 3.7.2
[✓] perl         not required on Windows (exiftool is native)
[✓] tool mirror  https://github.com/stefanopascazi/shoots/releases/download/tools-v1
[✓] exiftool     13.59 (C:\Users\jane\.shoots\bin\exiftool\13.59\exiftool.exe)
[✓] libraw       C:\Users\jane\.shoots\bin\libraw\0.21.4\dcraw_emu.exe
[✓] inference model  vit-b32-int8-2 (C:\Users\jane\.shoots\models\clip\vit-b32-int8-2)
[✓] sharp        libvips 8.15.3

9 checks: 9 ok, 0 warnings, 0 failed
```

### Fresh install, nothing provisioned yet

```
[✓] platform     linux/x64, node v22.11.0
[✓] shoots home  /home/jane/.shoots (writable)
[✓] tar          tar (GNU tar) 1.35
[✓] perl         v5.38.2
[✓] tool mirror  https://github.com/stefanopascazi/shoots/releases/download/tools-v1
[!] exiftool     not provisioned — run `shoots setup`
[!] libraw       not provisioned — run `shoots setup`
[!] inference model  not provisioned — run `shoots setup`
[✓] sharp        libvips 8.15.3

9 checks: 6 ok, 3 warnings, 0 failed
```

Exit code `0` — these are warnings, and every command would provision on demand.

### A real problem

```
[✓] perl         v5.38.2
[✗] exiftool     resolved but not runnable (/home/jane/.shoots/bin/exiftool/13.59/exiftool)
```

Exit code `1`. See [Troubleshooting](../troubleshooting.md).

### Using an external RAW developer

```
[✓] libraw       SHOOTS_RAW_DEVELOPER=rawtherapee-cli
```

`SHOOTS_RAW_DEVELOPER` takes precedence over the provisioned binary and is
reported as such.

---

## JSON output

```json
{
  "command": "doctor",
  "home": "/home/jane/.shoots",
  "checks": [
    { "name": "platform",        "status": "ok",   "detail": "linux/x64, node v22.11.0" },
    { "name": "shoots home",     "status": "ok",   "detail": "/home/jane/.shoots (writable)" },
    { "name": "tar",             "status": "ok",   "detail": "tar (GNU tar) 1.35" },
    { "name": "perl",            "status": "ok",   "detail": "v5.38.2" },
    { "name": "tool mirror",     "status": "ok",   "detail": "https://…/tools-v1" },
    { "name": "exiftool",        "status": "warn", "detail": "not provisioned — run `shoots setup`" },
    { "name": "libraw",          "status": "warn", "detail": "not provisioned — run `shoots setup`" },
    { "name": "inference model", "status": "warn", "detail": "not provisioned — run `shoots setup`" },
    { "name": "sharp",           "status": "ok",   "detail": "libvips 8.15.3" }
  ],
  "summary": { "failed": 0, "warned": 3, "total": 9 }
}
```

### Use it as a gate

```sh
# Hard gate — any failure stops the pipeline
shoots doctor --json > /dev/null || exit 1

# Strict gate — warnings are failures too
warned=$(shoots doctor --json | jq '.summary.warned + .summary.failed')
[ "$warned" -eq 0 ] || { echo "environment not ready"; exit 1; }

# Which specific checks are unhappy?
shoots doctor --json | jq -r '.checks[] | select(.status != "ok") | "\(.status)\t\(.name)\t\(.detail)"'
```

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | No check **failed** (warnings are tolerated) |
| `1` | At least one check failed |

---

## See also

- [`setup`](./setup.md) — fix most warnings in one command
- [Troubleshooting](../troubleshooting.md) — what each failure means
- [Configuration](../configuration.md) — the environment variables `doctor` reports on
