# `shoots rename`

Batch-rename already-imported files **in place**, using the same templating engine
as [`import`](./import.md).

```
shoots rename <path> --pattern <template> [options]
```

---

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<path>` | yes | Folder (or single file) to rename in place |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--pattern <template>` | **required** | [Filename template](../templates.md), e.g. `"{date}_{time}_{camera}_{seq:4}.{ext}"` |
| `--recursive` | **off** | Recurse into subdirectories (each file stays in its own directory) |
| `--dry-run` | off | Show planned renames without executing them |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

> **Note the default.** Unlike most commands, `rename` is **non-recursive by
> default**. Renaming is destructive-ish enough that recursing into an entire
> catalog should be an explicit choice.

---

## Behaviour

### Two-phase renaming makes swaps safe

Renames execute in two passes:

1. every changing file → a unique temp name in its own directory,
2. temp name → final name.

This makes in-set collisions and swaps (`A → B`, `B → A`) safe — impossible with a
naive single-pass rename. If phase 2 fails for a file, it is rolled back to its
original name rather than left stranded at a temp name.

### Files never leave their directory

`rename` is an in-place operation. With `--recursive`, each file is renamed within
the directory it already lives in; the folder structure is untouched. To *move*
files, use [`import`](./import.md).

### Unchanged files are counted, not touched

A file whose rendered name equals its current name is reported as `unchanged` and
skipped entirely.

### exiftool is required

Unlike `import`, `rename` does **not** degrade to mtime. Templates here are
expected to resolve real capture metadata, so exiftool must be available — it is
provisioned on first use, or you can point `SHOOTS_EXIFTOOL` at an existing binary.

---

## Examples

### Preview first, always

```sh
shoots rename D:/Shoots/2026/smith-wedding/raw \
  --pattern "{date}_{seq:4}_{orig}.{ext}" --dry-run
```

```
rename  IMG_0001.CR3  →  20260719_0001_IMG_0001.cr3
rename  IMG_0002.CR3  →  20260719_0002_IMG_0002.cr3

(dry run) 482 files would be renamed, 0 unchanged
```

### Execute

```sh
shoots rename D:/Shoots/2026/smith-wedding/raw --pattern "{date}_{seq:4}_{orig}.{ext}"
```

```
ok    IMG_0001.CR3  →  20260719_0001_IMG_0001.cr3
ok    IMG_0002.CR3  →  20260719_0002_IMG_0002.cr3

482 renamed, 0 unchanged, 0 failed
```

### Normalize a whole catalog

```sh
shoots rename D:/Shoots/2026 \
  --pattern "{year}{month}{day}_{time}_{camera}_{seq:4}.{ext}" \
  --recursive --dry-run
```

Each dated subfolder keeps its files; only names change.

### Client-facing names

```sh
shoots rename ./selects --pattern "SmithWedding_{seq:3}.{ext}"
```

→ `SmithWedding_001.cr3`, `SmithWedding_002.cr3`, …

### Undo-friendly workflow

`rename` has no undo. Capture the mapping first:

```sh
shoots rename ./raw --pattern "{date}_{seq:4}.{ext}" --dry-run --json > rename-plan.json
shoots rename ./raw --pattern "{date}_{seq:4}.{ext}" --json > rename-done.json
```

`rename-done.json` carries every `source → dest` pair, which is enough to script a
reversal.

---

## JSON output

### Dry run

```json
{
  "command": "rename",
  "dryRun": true,
  "files": [
    { "source": "D:\\...\\IMG_0001.CR3", "dest": "D:\\...\\20260719_0001.cr3", "unchanged": false },
    { "source": "D:\\...\\20260719_0002.cr3", "dest": "D:\\...\\20260719_0002.cr3", "unchanged": true }
  ]
}
```

### Real run

```json
{
  "command": "rename",
  "dryRun": false,
  "files": [
    { "source": "D:\\...\\IMG_0001.CR3", "dest": "D:\\...\\20260719_0001.cr3" }
  ],
  "errors": [],
  "summary": { "total": 482, "renamed": 482, "unchanged": 0, "failed": 0 }
}
```

Only files that actually changed appear in `files` on a real run.

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | All renames succeeded (or nothing needed renaming) |
| `1` | At least one rename failed |
| `2` | Invalid `--pattern`, or exiftool unavailable |

---

## See also

- [Filename templates](../templates.md) — every token, with worked examples
- [`import`](./import.md) — the same engine, applied while copying
