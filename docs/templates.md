# Filename templates

The same templating engine drives [`shoots import --pattern`](./commands/import.md),
[`shoots rename --pattern`](./commands/rename.md) and `import --dir`.

```
{date}_{time}_{camera}_{seq:4}.{ext}
```
→ `20260719_143052_Canon-EOS-R5_0001.cr3`

---

## Tokens

| Token | Renders | Fallback | Needs EXIF |
| --- | --- | --- | --- |
| `{date}` | Capture date, `YYYYMMDD` → `20260719` | `nodate` | yes |
| `{time}` | Capture time, `HHMMSS` → `143052` | `notime` | yes |
| `{year}` | `2026` | `noyear` | yes |
| `{month}` | Zero-padded month, `07` | `nomonth` | yes |
| `{day}` | Zero-padded day, `19` | `noday` | yes |
| `{camera}` | Camera model, sanitized → `Canon-EOS-R5` | `unknown-camera` | yes |
| `{lens}` | Lens model, sanitized → `RF24-70mm-F2.8-L-IS-USM` | `unknown-lens` | yes |
| `{orig}` | Original filename **without** extension → `IMG_0001` | — | no |
| `{seq}` | 1-based sequence number within the batch | — | no |
| `{ext}` | Lowercase extension **without** the dot → `cr3` | — | no |

An unknown token is a hard error, reported before anything is touched:

```
error: Invalid --pattern: Unknown template token {shutter}
```

---

## Zero-padding `{seq}`

`{seq}` accepts a width:

| Template | Output |
| --- | --- |
| `{seq}` | `1`, `2`, … `482` |
| `{seq:3}` | `001`, `002`, … `482` |
| `{seq:4}` | `0001`, `0002`, … `0482` |
| `{seq:6}` | `000001`, … |

Use a width **wider than your largest expected batch**, otherwise sorting breaks:
`{seq}` gives `1, 10, 100, 2` in a file browser, while `{seq:4}` gives
`0001, 0002, 0010, 0100`.

### Sequence numbers follow capture order

Files are sorted by **capture date** before numbering, not by filename. Shooting
two bodies into one folder therefore produces a single chronological sequence —
which is usually what you want and is impossible with a plain file-manager rename.

---

## Sanitization

`{camera}`, `{lens}` and `{orig}` are made filesystem-safe:

1. Trim leading/trailing whitespace.
2. Replace `\ / : * ? " < > |` and any whitespace run with a single `-`.
3. Collapse runs of `-` into one.
4. Strip leading/trailing `-`.

| Raw value | Sanitized |
| --- | --- |
| `Canon EOS R5` | `Canon-EOS-R5` |
| `RF24-70mm F2.8 L IS USM` | `RF24-70mm-F2.8-L-IS-USM` |
| `NIKON  Z 9` | `NIKON-Z-9` |
| `Sigma 35mm F1.4 DG HSM \| Art` | `Sigma-35mm-F1.4-DG-HSM-Art` |

Note that `.` is **not** replaced, so `F2.8` survives intact.

---

## Fallbacks and EXIF

When exiftool is unavailable or a tag is missing, tokens fall back rather than
failing:

- **Date tokens** fall back to the file's **mtime** first. Only when there is no
  usable date at all do you get `nodate` / `noyear` / …
- **`{camera}` / `{lens}`** have no fallback source and render as
  `unknown-camera` / `unknown-lens`.

`import`'s JSON output records `dateSource: "exif" | "mtime"` per file, so you can
audit which frames guessed:

```sh
shoots import E:/DCIM --dest ./raw --json | jq -r '.files[] | select(.dateSource=="mtime") | .source'
```

`rename` does **not** degrade this way — it requires exiftool.

---

## Directory templates (`import --dir`)

`--dir` uses the same tokens, with `/` as the folder separator. It is rendered
**per file**, so different capture dates land in different folders.

| `--dir` value | Result under `--dest` |
| --- | --- |
| `{year}/{year}-{month}-{day}` *(default)* | `2026/2026-07-19/` |
| `{year}/{month}/{day}` | `2026/07/19/` |
| `{year}-{month}-{day}` | `2026-07-19/` |
| `{camera}/{year}-{month}-{day}` | `Canon-EOS-R5/2026-07-19/` |
| `{year}/{month}/{camera}` | `2026/07/Canon-EOS-R5/` |
| *(use `--flat`)* | no subfolders |

`{seq}` in a `--dir` template renders as `0` — sequence numbering is a per-file
concept, not a per-folder one. Avoid it there.

---

## Worked examples

### Keep original names, date-foldered *(the default)*

```sh
shoots import E:/DCIM --dest ./catalog
```
→ `catalog/2026/2026-07-19/IMG_0001.CR3`

### Fully descriptive

```sh
shoots import E:/DCIM --dest ./catalog --pattern "{date}_{time}_{camera}_{seq:4}.{ext}"
```
→ `catalog/2026/2026-07-19/20260719_143052_Canon-EOS-R5_0001.cr3`

### Chronological, but traceable back to the camera's numbering

```sh
shoots rename ./raw --pattern "{date}_{seq:4}_{orig}.{ext}"
```
→ `20260719_0001_IMG_0001.cr3`

A good default: sorts chronologically, and the original frame number survives for
cross-referencing against the card.

### Client deliverables

```sh
shoots rename ./selects --pattern "SmithWedding_{seq:3}.{ext}"
```
→ `SmithWedding_001.jpg`

### Multi-body shoot, disambiguated

```sh
shoots import E:/DCIM --dest ./catalog --pattern "{date}_{camera}_{seq:4}.{ext}"
```
→ `20260719_Canon-EOS-R5_0001.cr3`, `20260719_Sony-A7R-V_0002.arw`

Sequence numbers still interleave chronologically across bodies.

### Lens-organized archive

```sh
shoots import E:/DCIM --dest ./archive \
  --dir "{year}/{lens}" \
  --pattern "{date}_{time}_{seq:4}.{ext}"
```
→ `archive/2026/RF24-70mm-F2.8-L-IS-USM/20260719_143052_0001.cr3`

### Flat, date-prefixed

```sh
shoots import E:/DCIM --dest ./inbox --flat --pattern "{year}{month}{day}_{orig}.{ext}"
```
→ `inbox/20260719_IMG_0001.cr3`

---

## Rules and gotchas

### Always include `{ext}`

Nothing forces it, but omitting `{ext}` produces extensionless files that no tool
will recognize. Put `.{ext}` at the end unless you have a specific reason not to.

### Templates are validated before execution

Every `--pattern` and `--dir` is rendered against a dummy context up front.
Invalid tokens or a template that renders empty fail with exit `2` before any
file is touched.

### Collisions are suffixed, never overwritten

If two files render to the same name, the later ones get `_2`, `_3`, …
`import` never overwrites an existing destination file, and `rename` never
overwrites an existing name.

### `rename` swaps are safe

`rename` runs two-phase (original → temp → final), so `A → B` and `B → A` in the
same batch work correctly.

### Case

`{ext}` is always lowercased (`.CR3` → `cr3`). Other tokens keep the case of their
source value.

### Windows path separators

Use `/` in `--dir` templates on every platform, including Windows. It is
normalized for you.
