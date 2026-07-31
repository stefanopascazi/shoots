# `shoots exif`

Batch read and write EXIF / IPTC / XMP metadata via exiftool.

```
shoots exif <path> [options]
```

The command has **two modes**, chosen automatically:

- **Read mode** — the default, when no write flag is given.
- **Write mode** — as soon as any `--set-*`, `--set` or `--config` flag appears.

---

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<path>` | yes | Folder (recursive by default) or a single file |

## Options

### Read mode

| Option | Default | Description |
| --- | --- | --- |
| `--tags <list>` | common set | Comma-separated tag names to read |

The default read set is:
`FileName` `DateTimeOriginal` `Model` `LensModel` `ISO` `FNumber` `ExposureTime`
`FocalLength` `Artist` `Copyright` `Keywords` `Rating` `ImageWidth` `ImageHeight`

### Write mode

| Option | Description |
| --- | --- |
| `--set-artist <text>` | Write `Artist` / Creator |
| `--set-copyright <text>` | Write `Copyright` |
| `--set-keywords <list>` | Write comma-separated `Keywords` **and** `XMP:Subject` |
| `--set <Tag=Value>` | Write an arbitrary exiftool tag. **Repeatable.** |
| `--config <file>` | YAML/JSON file of tags to write |
| `--overwrite-original` | Skip exiftool's `*_original` backup files |

### Both modes

| Option | Default | Description |
| --- | --- | --- |
| `--no-recursive` | recursive | Do not descend into subdirectories |
| `--dry-run` | off | Show what would be written without touching files *(write mode)* |
| `--json` | off | Machine-readable JSON on stdout |
| `--verbose` | off | Verbose logging on stderr |

---

## Behaviour

### Backups are kept by default

exiftool writes a `<file>_original` backup beside each modified file. `shoots`
keeps that behaviour, and reminds you it did. Pass `--overwrite-original` to skip
it — that is the only way `exif` modifies a file irreversibly, so it is explicit.

```
Wrote 3 tags to 482 files (482 image files updated)
Originals preserved as *_original backups (exiftool default).
```

Once you have verified the write, the backups are ordinary files you can delete.

### Flags win over `--config`

When both are given, the file supplies the base and command-line flags override
per key. This makes a shared studio config usable with per-shoot overrides:

```sh
shoots exif ./raw --config studio-tags.yaml --set-keywords wedding,smith,2026
```

### `--set-keywords` writes two places

Keywords are written to both legacy IPTC `Keywords` and `XMP:Subject`, because
different downstream tools read different ones. Lightroom reads `XMP:Subject`.

### Recursion default

Unlike `rename`, `exif` **recurses by default**. Use `--no-recursive` to limit it
to a single directory level.

### exiftool is required

Every operation shells out to exiftool. It is provisioned on first use, or you can
point `SHOOTS_EXIFTOOL` at an existing binary.

---

## Examples

### Read: quick inspection

```sh
shoots exif ./raw
```

```
D:/raw/IMG_0001.CR3  date=2026:07:19 14:30:52  camera=Canon EOS R5  lens=RF24-70mm F2.8 L IS USM  iso=800  f=2.8  t=1/250
D:/raw/IMG_0002.CR3  date=2026:07:19 14:30:54  camera=Canon EOS R5  lens=RF24-70mm F2.8 L IS USM  iso=800  f=2.8  t=1/250

482 files read
```

### Read: a specific tag set as JSON

```sh
shoots exif ./raw --tags FileName,ISO,FNumber,ExposureTime,LensModel --json
```

### Read: build a shoot report

```sh
# Which lenses did I actually use?
shoots exif ./raw --json | jq -r '.files[].LensModel' | sort | uniq -c | sort -rn

# ISO distribution
shoots exif ./raw --json | jq -r '.files[].ISO' | sort -n | uniq -c

# Frames shot wide open
shoots exif ./raw --json | jq -r '.files[] | select(.FNumber <= 2.0) | .SourceFile'
```

### Write: studio boilerplate

```sh
shoots exif ./raw \
  --set-artist "Jane Doe Photography" \
  --set-copyright "© 2026 Jane Doe Photography. All rights reserved." \
  --set-keywords wedding,smith,2026 \
  --dry-run
```

```
Would write:
  Artist = Jane Doe Photography
  Copyright = © 2026 Jane Doe Photography. All rights reserved.
  Keywords = wedding, smith, 2026
  XMP:Subject = wedding, smith, 2026
to 482 files (dry run)
```

Drop `--dry-run` to apply.

### Write: arbitrary tags, repeatable

```sh
shoots exif ./raw \
  --set "XMP:City=Rome" \
  --set "XMP:Country=Italy" \
  --set "XMP:Location=Villa Borghese" \
  --set "IPTC:Credit=Jane Doe Photography"
```

### Write: from a config file

`studio-tags.yaml`:

```yaml
artist: "Jane Doe Photography"
copyright: "© 2026 Jane Doe Photography. All rights reserved."
keywords:
  - professional
  - jane-doe
XMP:CreatorWorkEmail: "hello@janedoe.photo"
XMP:CreatorWorkURL: "https://janedoe.photo"
IPTC:Credit: "Jane Doe Photography"
```

```sh
shoots exif ./raw --config studio-tags.yaml
```

Key mapping: `artist` → `Artist`, `copyright` → `Copyright`, `keywords` →
`Keywords`. Any other key is passed to exiftool verbatim, so full
`Group:Tag` syntax works. JSON files are accepted too (the YAML parser reads both).

### Write: single directory only

```sh
shoots exif ./catalog/2026-07-19 --no-recursive --set-keywords day-one
```

---

## JSON output

### Read mode

```json
{
  "command": "exif",
  "mode": "read",
  "files": [
    {
      "SourceFile": "D:/raw/IMG_0001.CR3",
      "FileName": "IMG_0001.CR3",
      "DateTimeOriginal": "2026:07:19 14:30:52",
      "Model": "Canon EOS R5",
      "LensModel": "RF24-70mm F2.8 L IS USM",
      "ISO": 800,
      "FNumber": 2.8,
      "ExposureTime": "1/250",
      "FocalLength": "50.0 mm",
      "ImageWidth": 8192,
      "ImageHeight": 5464
    }
  ]
}
```

Records are exiftool's own output shape, so any tag you request appears with its
canonical exiftool name.

### Write mode

```json
{
  "command": "exif",
  "mode": "write",
  "dryRun": false,
  "tags": {
    "Artist": "Jane Doe Photography",
    "Copyright": "© 2026 Jane Doe Photography. All rights reserved.",
    "Keywords": ["wedding", "smith", "2026"],
    "XMP:Subject": ["wedding", "smith", "2026"]
  },
  "files": ["D:/raw/IMG_0001.CR3", "..."],
  "exiftool": "482 image files updated"
}
```

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | Read succeeded, or all writes succeeded |
| `1` | exiftool reported a write failure |
| `2` | Malformed `--set` (missing `=`), unreadable `--config`, or exiftool unavailable |

---

## See also

- [`rate --write-xmp`](./rate.md) — writes rating + keyword sidecars, not embedded tags
- [Recipes](../recipes.md) — metadata as part of a full ingest
