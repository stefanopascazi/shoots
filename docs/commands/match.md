# `shoots match`

Pairwise preference learning: you duel your own photos two at a time — "keep
this one, drop that one" — and the outcomes train a rating profile that
generalizes **your** eye to photographs you have never judged.

```
shoots match <subcommand> [options]
```

The built-in [rating profiles](../profiles.md) are priors: someone else's
judgement, or none at all. This is the command that replaces guessing with
measurement.

| Subcommand | Purpose |
| --- | --- |
| [`import`](#shoots-match-import) | Load a `shoots embeddings` bundle into the duel database |
| [`serve`](#shoots-match-serve) | Open the local duel UI and record your judgements |
| [`train`](#shoots-match-train) | Fit the profile from the duels recorded so far |

It never loads the ONNX runtime. `shoots embeddings` is the feature extractor;
`match` only ever touches numbers and the image files the UI displays.

For the conceptual walk-through — how many photos, how many duels, what the
accuracy means — see [Preference learning](../preference-learning.md).

---

## `--name` is the through-line

One name identifies the database, the profile, and the argument you later pass
to `rate`:

```sh
shoots match import --data ./bundle/embeddings.json --name my-street
shoots match serve  --name my-street
shoots match train  --name my-street
shoots rate ./new-shoot --profile my-street --write-xmp
```

| What | Where it lands |
| --- | --- |
| Duel database | `~/.shoots/match/<name>.db` |
| Trained profile | `~/.shoots/profiles/<name>.json` |

`~/.shoots/profiles/` is exactly where `rate --profile <name>` looks, so nothing
has to be copied into place. Both defaults are overridable (`--db`, `--out`), and
both honour `SHOOTS_HOME`.

Names must be filename-safe: letters, digits, dot, dash, underscore. Built-in
profile names win over learned ones, so do not call yours `street`.

**One database per genre.** A single linear head cannot be a street eye and a
wildlife eye at the same time. Separate names, separate databases, separate
profiles.

---

## `shoots match import`

```
shoots match import --data <file> [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--data <file>` | **required** | `embeddings.json` from `shoots embeddings --out <dir>` |
| `--name <name>` | `my-eye` | Profile this database trains — names the DB |
| `--images <dir>` | — | Base folder for resolving image paths in the UI |
| `--db <file>` | `~/.shoots/match/<name>.db` | Database file |
| `--json` | off | Machine-readable JSON on stdout |

Import is **idempotent on path**: re-running it after adding photos refreshes
embeddings and merges the new frames **without losing a single duel** you have
already judged.

Preview paths inside a bundle are resolved relative to `embeddings.json`, so the
bundle stays movable.

```sh
shoots embeddings ~/Pictures/street --out ./bundle
shoots match import --data ./bundle/embeddings.json --name my-street
```

```
Imported 1204 photos from ./bundle/embeddings.json (model vit-b32-int8-2, dim 512) → ~/.shoots/match/my-street.db
Photos in DB: 1204 (1204 new)
```

**RAW needs the bundle form.** RAW originals are not browser-viewable, so
`--out <dir>` writes JPEG previews the duel UI can display. A plain `--json`
dataset points at the originals, which only render if they are themselves
viewable — see [`embeddings`](./embeddings.md).

---

## `shoots match serve`

```
shoots match serve [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--name <name>` | `my-eye` | Profile this database trains — names the DB |
| `--db <file>` | `~/.shoots/match/<name>.db` | Database file |
| `--port <n>` | `4576` | Port |
| `--host <host>` | `127.0.0.1` | Host — **local by default** |

```
Duel UI on http://127.0.0.1:4576  (Ctrl+C to stop)
1204 photos, 0 duels recorded so far
```

Two photos, side by side.

| Input | Action |
| --- | --- |
| `←` / `→` or click | Keep that one |
| `space` | Skip the pair |

The page is served from the binary itself — no files are written, nothing is
uploaded, and the server binds to loopback unless you say otherwise. Ctrl+C
stops it; every duel is already committed to the database as you make it.

### Active learning

Pairs are not random. The strategy picks the **least-compared photo** against its
**closest current rival**, seeded from the neutral CLIP aesthetic. Each duel
therefore carries close to the maximum information — you spend attention where
the model is genuinely uncertain, not confirming what it already knows.

---

## `shoots match train`

```
shoots match train [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `--name <name>` | `my-eye` | Profile name — also names the DB and `rate --profile` |
| `--out <file>` | `~/.shoots/profiles/<name>.json` | Output profile path |
| `--db <file>` | `~/.shoots/match/<name>.db` | Database file |
| `--lambda <n>` | `1` | Ridge regularization strength |
| `--holdout <frac>` | `0.2` | Fraction of duels held out for accuracy |
| `--json` | off | Machine-readable JSON on stdout |

```
Trained 'my-street' from 634 duels over 1204 photos
  → ~/.shoots/profiles/my-street.json  (dim 512, model vit-b32-int8-2)
  held-out pairwise accuracy: 0.71
Apply it: shoots rate <folder> --profile my-street
```

Four stages:

1. **Bradley-Terry** latent scores over the duel outcomes — a global ranking from
   pairwise comparisons.
2. A **ridge linear head** on the embeddings, so *unseen* photos get a score.
   This is what makes the profile generalize rather than memorize.
3. **Percentile star calibration** — placing the 0–5 boundaries so the
   distribution matches your actual keeper rate.
4. A **held-out pairwise-accuracy check**.

Training needs at least **10 duels** and reads only the database, so it is fast
and repeatable: retrain with different `--lambda` values as often as you like
without judging anything again.

### Reading the accuracy

| Accuracy | Reading |
| --- | --- |
| `~0.50` | Chance. Not learning — too few duels, or inconsistent judgements. |
| `0.60–0.70` | Real signal. Usable. |
| `0.70–0.80` | Good. The profile meaningfully reflects your taste. |
| `> 0.85` | Suspiciously high on a small set — check you have enough held-out duels. |

Human preference on photographs is genuinely noisy: you will not agree with
*yourself* 100% of the time on a rerun. Do not expect 0.95.

### Tuning `--lambda`

Higher = more regularization = a smoother, more conservative profile. Raise it if
the profile behaves erratically on new work (overfitting); lower it if it is
bland and ignores your judgements.

---

## The deliverable

A `type: "linear-embedding"` profile whose field names mirror the
`RatingProfile` shape — a flat focus gate plus `aestheticStars`.
`embeddingModel` guards that the profile is only ever applied to the CLIP space
it was learned on. Full schema in
[Rating profiles](../profiles.md#the-linear-embedding-shape).

---

## Storage

SQLite, through whichever driver the running process already has: `bun:sqlite`
in the standalone binary, `node:sqlite` when running from source. No native
build, no external dependency, no separate install.

**The database is your work.** It holds every duel you have ever judged — hours
of attention that cannot be recomputed. Back up `~/.shoots/match/`. Nothing in
`shoots` ever deletes it.

---

## Coming from the standalone `tools/match`

`match` used to be a separate npm project with its database in the working
directory (`./match.db`). The schema is unchanged — every duel you judged then is
still valid. Move the database where the new defaults look for it:

```sh
mkdir -p ~/.shoots/match
mv match.db     ~/.shoots/match/my-eye.db
mv match.db-wal ~/.shoots/match/my-eye.db-wal   # if present
mv match.db-shm ~/.shoots/match/my-eye.db-shm   # if present
```

```sh
shoots match train --name my-eye
```

Or leave it where it is and point at it every time with `--db ./match.db`.

The first open **checkpoints the write-ahead log** into the main file, which is
ordinary SQLite housekeeping — same data, no loss. `npm install` and the build
step are no longer needed for any of it.

---

## Examples

### The whole loop

```sh
shoots embeddings ~/Pictures/street-2020-2026 --out ~/work/street-bundle
shoots match import --data ~/work/street-bundle/embeddings.json --name my-street
shoots match serve --name my-street          # judge ~600 pairs, then Ctrl+C
shoots match train --name my-street
shoots rate ~/Shoots/2026-07-rome --profile my-street --write-xmp
```

### Grow an existing database

```sh
shoots embeddings ~/Pictures/street-2026 --out ~/work/street-2026
shoots match import --data ~/work/street-2026/embeddings.json --name my-street
shoots match train --name my-street          # existing duels survive
```

### A database somewhere else

```sh
shoots match import --data ./bundle/embeddings.json --db /volumes/work/street.db
shoots match serve --db /volumes/work/street.db
shoots match train --db /volumes/work/street.db --name my-street
```

### Judge from another machine on the LAN

```sh
shoots match serve --name my-street --host 0.0.0.0
```

The images and the database never leave the machine running the command — only
the page and the JPEG previews it requests do. Only do this on a network you
trust; there is no authentication.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The command failed (bad dataset, too few duels, mixed embedding spaces) |
| `2` | Bad usage |

---

## See also

- [Preference learning](../preference-learning.md) — the guide, end to end
- [`embeddings`](./embeddings.md) — the export that feeds `import`
- [Rating profiles](../profiles.md) — the profile format and the built-in priors
- [`rate`](./rate.md) — applying the profile you just trained
