# `shoots release-notes`

What this release asks of *you*: the steps a new version makes necessary,
checked against the profile and dataset actually stored in `~/.shoots`.

```
shoots release-notes [options]
```

This is **not** a changelog. The changelog is generated from the commits and
lists what changed; a migration note says what you must do about it, which no
commit can tell you. The two live apart on purpose — see
[Migration notes](../migrations.md) for the full list.

---

## Options

| Option | Description |
| --- | --- |
| `--all` | Show every migration note ever published, not just the outstanding ones |
| `--json` | Machine-readable JSON on stdout |
| `--verbose` | Verbose logging on stderr |

---

## How it works

1. Read the shoots version stamped into your develop **profile**
   (`~/.shoots/develop/profile/export.json`) and **dataset**
   (`~/.shoots/develop/export/export.jsonl`).
2. Select the migration notes published *after* that version and *up to* the
   running one.
3. Print them, required steps first, and exit `1` if any step is still
   outstanding.

An artefact with no stamp was built by 0.4.8 or earlier — before the stamp
existed — so every note applies to it.

The reference point is the stored artefacts, not "have you read this before":
acknowledging a note does not rebuild a profile, so the warning stays until the
rebuild actually happens.

`develop refresh-targets` deliberately carries the old stamp through: it
rewrites the targets and leaves the feature vectors as they were exported, so
re-stamping it would hide a migration that is still outstanding.

---

## Examples

### After an update

```sh
shoots release-notes
```

```
shoots 0.5.0 — release notes

  profile  built by 0.4.8 or earlier  ~/.shoots/develop/profile/export.json
  dataset  built by 0.4.8 or earlier  ~/.shoots/develop/export/export.jsonl

⚠ A required step is outstanding — the develop predictor will refuse to run until it is done.

──────────────────────────────────────────────────────────────────────────────
0.5.0 — Re-run `develop init`: the colour features widened from 44 to 50
  ACTION REQUIRED
  affects: profile (built by 0.4.8 or earlier), dataset (built by 0.4.8 or earlier)

  The develop predictor learned six new photometric features …

  Do this:
    $ shoots develop init <your-edited-catalog>
```

### Nothing to do

```
shoots 0.5.0 — release notes

  profile  built by 0.5.0  ~/.shoots/develop/profile/export.json
  dataset  built by 0.5.0  ~/.shoots/develop/export/export.jsonl

Everything on this machine matches this build. Nothing to do.
```

### Fail a scheduled job while a step is pending

```sh
shoots release-notes || { echo "shoots needs attention"; exit 1; }
shoots develop refine <shoot>
```

### The whole history

```sh
shoots release-notes --all
```

---

## JSON output

```json
{
  "command": "release-notes",
  "version": "0.5.0",
  "artifacts": [
    { "kind": "profile", "path": "…/develop/profile/export.json", "version": null },
    { "kind": "dataset", "path": "…/develop/export/export.jsonl", "version": null }
  ],
  "outstanding": [
    {
      "version": "0.5.0",
      "title": "Re-run `develop init`: the colour features widened from 44 to 50",
      "required": true,
      "affects": ["profile", "dataset"],
      "summary": "…",
      "steps": ["shoots develop init <your-edited-catalog>"],
      "notes": ["…"],
      "staleArtifacts": ["profile", "dataset"]
    }
  ],
  "requiredCount": 1
}
```

`version: null` on an artefact means it predates the stamp (0.4.8 or earlier).
With `--all`, an extra `all` array carries every published note.

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | Nothing outstanding, no artefacts to migrate, or `--all` |
| `1` | At least one **required** step is outstanding |

Informational notes never affect the exit code.

---

## See also

- [Migration notes](../migrations.md) — the published entries in full
- [`develop`](./develop.md) — `develop init`, the usual fix
- [`update`](./update.md) — getting the new version in the first place
