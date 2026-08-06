# `shoots triage`

The marks `cull` and `rate` record, before they reach a sidecar.

```
shoots triage list [<path>]
shoots triage apply <path> [options]
shoots triage clean [options]
```

---

## Why marks exist

A shoot goes `cull` → `rate` → `develop`. If each of those wrote its own XMP
sidecar, the last one would win: `develop` templates the whole file to emit
`crs:`, `rate` used to refuse to start when a sidecar already existed, and every
editor reads and rewrites sidecars on its own terms. Three commands writing the
same file in sequence is a data-loss machine.

So Shoots draws one line:

> **Only the write path creates a sidecar.** `cull` and `rate` record *marks*
> under `~/.shoots/triage`. `develop edit` — or this command — reconstructs them
> in the target editor's vocabulary and merges them in.

Nothing lands next to your photographs until you ask for it.

### Marks are meanings, not colours

A mark says `reject`, not `Red`. `xmp:Label` is a standard *field* carrying a
non-standard *value*: it is free text, Lightroom and Bridge colour it only when
the string matches the user's label set (which is localized), and darktable has
five unnamed slots instead. Storing the colour would mean choosing for an editor
you have not picked yet.

The translation happens at write time, from a label set you control — see
[Configuration](../configuration.md#label-sets).

| Semantic label | Default (ACR / Lightroom) |
| --- | --- |
| `reject` | Red |
| `select` | Green |
| `review` | Yellow |
| `second-pass` | Purple |

---

## Producing marks

| Command | Records |
| --- | --- |
| `shoots cull <path> --mark` | `reject` + the blur verdict, scores and thresholds |
| `shoots cull <path> --mark --mark-keepers select` | …and labels the keepers too |
| `shoots rate <path> --mark` | stars + suggested keywords, with the scores behind them |

Marks from different commands **merge field by field**, so rating a shoot after
culling it adds stars without erasing the rejection.

```sh
shoots cull ./shoot --mark
shoots rate ./shoot --mark
shoots triage list ./shoot
```

---

## `triage list`

What is waiting, for one shoot or for the whole machine.

```sh
shoots triage list                 # every shoot with marks
shoots triage list ./shoot         # just this one
```

```
     0 pending       3 applied   ~/.shoots/triage/2026-07-19-ee6e0b80.jsonl
     2 pending       0 applied   ~/.shoots/triage/2026-07-20-da84c8f6.jsonl

2 pending, 3 applied
```

**Pending** marks have not reached a sidecar. **Applied** ones have, and are kept
so a discarded sidecar can be rebuilt — `triage clean` drops them.

## `triage apply`

Write the pending marks into XMP sidecars next to the photographs.

```
shoots triage apply <path> [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--editor <id>` | `acr` | Whose vocabulary and sidecar format to write in: `acr` (`.xmp`, needs exiftool) or `rapidraw` (`.rrdata`, does not) |
| `--redo` | off | Also rewrite marks already applied once |
| `--dry-run` | off | Report what would be written, write nothing |
| `--json` | off | Machine-readable JSON on stdout |

```sh
shoots triage apply ./shoot --dry-run
```

```
IMG_0001.CR3  →  IMG_0001.xmp  Label=Red Rating=2 Subject=portrait/backlit
IMG_0002.CR3  →  IMG_0002.xmp  Label=Green Rating=4 Subject=landscape

(dry run) 2 sidecar(s) would be written in acr vocabulary
```

You do **not** need this when you develop the shoot: `develop edit` applies
pending marks on its way past. It exists for the workflow that ends at rating —
cull, rate, then edit by hand in Lightroom — where the marks would otherwise have
no way out.

Existing sidecars are merged into, never replaced: `crs:` develop settings,
captions and authorship survive.

## `triage clean`

```
shoots triage clean [--orphans] [--dry-run] [--json]
```

| Option | Description |
| --- | --- |
| `--orphans` | Also drop pending marks whose photograph no longer exists |
| `--dry-run` | Count what would be dropped, drop nothing |

Applied marks are dropped by default; pending ones are kept unless `--orphans`
finds their file gone. A store file with nothing left in it is removed.

---

## How marks survive a move

A mark is keyed by absolute path — deterministic, and free. `rename` and
`cull --dest` therefore report the move and the marks follow the file:

```sh
shoots cull ./shoot --mark --dest ./rejects   # marks move to ./rejects
shoots rename ./shoot --pattern "{date}_{seq}{ext}"   # marks follow the new names
```

Move a file with Explorer or `mv` and nothing tells the store. The mark is then
an orphan; `triage clean --orphans` collects it.

---

## Where marks live

`~/.shoots/triage/<folder>-<digest>.jsonl` — one file per shoot (the digest keeps
two folders called `2026-07-19` apart). One JSON record per photograph:

```jsonc
{
  "file": "D:/shoot/IMG_0001.CR3",
  "size": 28371922, "mtimeMs": 1785743136469,
  "marks": { "reject": true, "label": "reject", "stars": 1, "keywords": ["backlit"] },
  "sources": {
    "cull": { "tool": "cull@0.5.1", "at": "…", "verdict": "blurry", "score": 31.02 },
    "rate": { "tool": "rate@0.5.1", "at": "…", "profile": "street", "aesthetic": 0.41 }
  }
}
```

`marks` is the contract the sidecar writers read. `sources` is provenance: why a
mark says what it says, and which build decided it. Reads index across *every*
store file, so culling `shoot/day1` and developing `shoot/` still find each other.

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | Completed with no per-file failures |
| `1` | At least one sidecar failed to write |
| `2` | Unknown `--editor`, an adapter that cannot write annotations, or a malformed label set |

---

## See also

- [`cull`](./cull.md) — produces `reject` marks
- [`rate`](./rate.md) — produces star and keyword marks
- [`develop`](./develop.md) — `edit` applies pending marks alongside its prediction
- [Configuration](../configuration.md#label-sets) — remapping the label vocabulary
