# `shoots import`

Offload a card (or any source folder) into a destination catalog — optionally
renamed from EXIF, always checksum-verified.

```
shoots import <source> --dest <path> [options]
```

---

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<source>` | yes | Source directory (scanned recursively) or a single file |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--dest <path>` | **required** | Destination directory |
| `--rename` | off | Rename using the default template `{camera}{orig}.{ext}` |
| `--pattern <template>` | — | Rename using a custom [filename template](../templates.md). Implies `--rename`. |
| `--dir <template>` | `{year}/{year}-{month}-{day}` | Subfolder template under `--dest` |
| `--flat` | off | Copy straight into `--dest` with no date subfolders |
| `--move` | off | Delete each source **after** its copy is checksum-verified |
| `--concurrency <n>` | `4` | Max parallel file operations |
| `--dry-run` | off | Show the planned actions without executing them |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

---

## Behaviour

### Copy is the default; `--move` is verified

`import` copies. With `--move`, the source file is deleted **only after** the
copy's SHA-256 has been compared against the source's and matched. This is the
single reason `--move` is safe to point at a card you are about to reformat.

### Every copy is checksum-verified

Source and destination are both hashed with SHA-256 after the copy. On a mismatch:

- the command **deletes the corrupt copy** (never the source),
- reports the file as failed with both digests,
- continues with the rest of the batch,
- exits `1`.

### Names are kept unless you ask otherwise

Renaming is opt-in. Without `--rename` or `--pattern`, files keep their original
names (`{orig}.{ext}`). Your camera's numbering carries meaning; `shoots` will not
discard it silently.

| You pass | Effective pattern |
| --- | --- |
| *(nothing)* | `{orig}.{ext}` — original name preserved |
| `--rename` | `{camera}{orig}.{ext}` |
| `--pattern "..."` | your template |

### Date folders are the default

Files land in `<dest>/{year}/{year}-{month}-{day}/`, a Lightroom-style catalog
layout. Change it with `--dir`, disable it with `--flat`.

Dates come from EXIF `DateTimeOriginal` when exiftool is available, otherwise from
the file's mtime. The JSON output records which was used per file, as
`dateSource: "exif" | "mtime"`.

### Collisions are never overwritten

If the computed destination name already exists, `shoots` appends `_2`, `_3`, …
An existing file is never overwritten, in any mode.

### Sequence numbers follow capture order

`{seq}` is assigned after sorting the batch by capture date, not by filename. See
[Filename templates](../templates.md).

### exiftool is optional here

EXIF is read only when a name or directory template references capture metadata.
If exiftool cannot be provisioned, `import` **degrades rather than aborting**:
dates fall back to mtime (date folders still work) and `{camera}`/`{lens}` render
as `unknown-camera` / `unknown-lens`.

---

## Examples

### Safest first run

```sh
shoots import E:/DCIM/100CANON --dest D:/Shoots/2026/smith-wedding --dry-run
```

```
copy  E:\DCIM\100CANON\IMG_0001.CR3  →  D:\Shoots\2026\smith-wedding\2026\2026-07-19\IMG_0001.CR3
copy  E:\DCIM\100CANON\IMG_0002.CR3  →  D:\Shoots\2026\smith-wedding\2026\2026-07-19\IMG_0002.CR3

(dry run) 482 files would be copied to D:\Shoots\2026\smith-wedding
```

### Real offload

```sh
shoots import E:/DCIM/100CANON --dest D:/Shoots/2026/smith-wedding
```

```
ok    E:\DCIM\100CANON\IMG_0001.CR3  →  D:\Shoots\2026\smith-wedding\2026\2026-07-19\IMG_0001.CR3  [sha256 verified]
ok    E:\DCIM\100CANON\IMG_0002.CR3  →  D:\Shoots\2026\smith-wedding\2026\2026-07-19\IMG_0002.CR3  [sha256 verified]

482/482 files copied to D:\Shoots\2026\smith-wedding
```

### Renamed, fully descriptive

```sh
shoots import E:/DCIM/100CANON \
  --dest D:/Shoots/2026/smith-wedding/raw \
  --pattern "{date}_{time}_{camera}_{seq:4}.{ext}"
```

→ `20260719_143052_Canon-EOS-R5_0001.cr3`

### Flat destination, no date folders

```sh
shoots import E:/DCIM --dest ./raw --flat
```

### Custom folder layout: by camera, then date

```sh
shoots import E:/DCIM --dest ./catalog --dir "{camera}/{year}-{month}-{day}"
```

→ `./catalog/Canon-EOS-R5/2026-07-19/IMG_0001.CR3`

### Clearing a card safely

```sh
shoots import E:/DCIM --dest D:/Shoots/2026/smith-wedding --move --verbose
```

Each source is deleted only after its copy verifies. Any file that fails
verification leaves its source untouched.

### Two-card shoot, merged into one catalog

```sh
for card in E: F:; do
  shoots import "$card/DCIM" --dest D:/Shoots/2026/smith-wedding --json \
    >> import-log.jsonl || echo "FAILED: $card"
done
```

Collision suffixes (`_2`, `_3`) keep the second card's identically-numbered files
intact.

---

## JSON output

### Dry run

```json
{
  "command": "import",
  "dryRun": true,
  "move": false,
  "files": [
    {
      "source": "E:\\DCIM\\100CANON\\IMG_0001.CR3",
      "dest": "D:\\Shoots\\2026\\smith-wedding\\2026\\2026-07-19\\IMG_0001.CR3",
      "dateSource": "exif"
    }
  ]
}
```

### Real run

```json
{
  "command": "import",
  "dryRun": false,
  "move": false,
  "files": [
    {
      "source": "E:\\DCIM\\100CANON\\IMG_0001.CR3",
      "dest": "D:\\Shoots\\2026\\smith-wedding\\2026\\2026-07-19\\IMG_0001.CR3",
      "checksum": "9f2b1c...",
      "verified": true,
      "moved": false,
      "dateSource": "exif"
    }
  ],
  "errors": [],
  "summary": { "total": 482, "succeeded": 482, "failed": 0 }
}
```

| Field | Meaning |
| --- | --- |
| `checksum` | SHA-256 of the file (identical on both sides — that is the point) |
| `verified` | Always `true` for a file in `files`; a failed verification lands in `errors` |
| `moved` | Whether the source was deleted (`--move`) |
| `dateSource` | `"exif"` or `"mtime"` — where the capture date came from |

### Useful queries

```sh
# Files whose date came from mtime, not EXIF — worth a second look
shoots import E:/DCIM --dest ./raw --json | jq -r '.files[] | select(.dateSource=="mtime") | .source'

# Total imported bytes verified
shoots import E:/DCIM --dest ./raw --json | jq '.summary.succeeded'
```

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | Every file copied and verified |
| `1` | At least one file failed to copy or verify |
| `2` | Invalid `--pattern` or `--dir` template |

---

## See also

- [Filename templates](../templates.md) — the token language
- [`rename`](./rename.md) — apply a template to an already-imported folder
- [Recipes](../recipes.md) — full ingest workflows
