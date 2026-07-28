# `shoots update`

Self-update the standalone binary: query the latest GitHub release, and if it is
newer, download the matching per-platform asset, verify it, and swap it in place.

```
shoots update [options]
```

---

## Options

| Option | Description |
| --- | --- |
| `--check` | Only report whether an update is available; install nothing |
| `--json` | Machine-readable JSON on stdout |
| `--verbose` | Verbose logging on stderr |

---

## How it works

1. Fetch `https://api.github.com/repos/<repo>/releases/latest`.
2. Compare the release tag to the running version with semver ordering.
3. Pick the asset for this platform/arch.
4. Download `SHA256SUMS.txt` from the release and pull out that asset's digest.
5. Download the asset to a staging file, **verifying the SHA-256 as it streams**.
6. Swap it in place.

### Platform assets

| Platform | Asset |
| --- | --- |
| Windows x64 | `shoots-windows-x64.exe` |
| Linux x64 | `shoots-linux-x64` |
| Linux arm64 | `shoots-linux-arm64` |
| macOS arm64 | `shoots-darwin-arm64` |

Intel macOS (`darwin-x64`) is intentionally not built — there is no reliable Intel
CI runner, and the Bun binary embeds per-arch native addons, so no universal build
is possible.

### The in-place swap

- **Unix** — `rename` onto the running executable is atomic even while it
  executes.
- **Windows** — a running `.exe` cannot be overwritten, but it *can* be renamed
  aside. The old binary moves to `<exe>.old`, the new one takes its place, and the
  `.old` file is cleaned up best-effort (it stays locked until the current process
  exits, so a leftover `shoots.exe.old` is normal and harmless — it disappears on
  the next run).

Restart `shoots` after an update to run the new version.

---

## Examples

### Check without installing

```sh
shoots update --check
```

```
Update available: v0.4.1 → v0.5.0
```

or

```
Up to date (v0.4.1).
```

### Update

```sh
shoots update
```

```
Update available: v0.4.1 → v0.5.0
  100%
Updated to v0.5.0. Restart shoots to run the new version.
```

### Scripted, weekly

```sh
if shoots update --check --json | jq -e '.hasUpdate' > /dev/null; then
  shoots update --json
fi
```

### In CI, avoiding rate limits

```sh
GITHUB_TOKEN="$GH_PAT" shoots update --check --json
```

The anonymous GitHub API limit is low; a token raises it substantially.

### Against a fork

```sh
SHOOTS_REPO=mystudio/shoots-internal shoots update
```

---

## JSON output

```json
{
  "command": "update",
  "current": "0.4.1",
  "latest": "v0.5.0",
  "hasUpdate": true,
  "installed": true
}
```

`installed` appears only after a successful install. With `--check`, or when
already current, only the first four fields are emitted.

No releases published yet:

```json
{ "command": "update", "current": "0.4.1", "latest": null, "hasUpdate": false }
```

---

## Limits

**`update` only works on the standalone binary.** Running it from a `node` or
`bun` process — i.e. from source — exits `2`:

```
error: `shoots update` only works on the standalone binary, not when run via node/bun.
```

From a source checkout, use `git pull && npm run build` instead.

You also need write permission on the directory containing the executable. A
binary installed into `/usr/local/bin` needs `sudo`; the default `~/.shoots/bin`
does not.

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | Up to date, update reported (`--check`), or update installed |
| `1` | GitHub unreachable, no asset for this platform, missing checksum, or the swap failed |
| `2` | Running from node/bun instead of the standalone binary |

---

## See also

- [Getting started](../getting-started.md) — the installers
- [Configuration](../configuration.md) — `SHOOTS_REPO`, `GITHUB_TOKEN`
