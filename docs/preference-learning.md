# Preference learning — teach `shoots` your eye

The built-in [rating profiles](./profiles.md) are priors. Only `street` is
calibrated, and even that is calibrated against *one photographer's* judgement.

This pipeline replaces guessing with measurement: you duel your own photos two at
a time — "keep this one, drop that one" — and the outcomes train a rating profile
that generalizes **your** taste to photos you have never judged.

---

## The pipeline

```
shoots embeddings <my-photos> --out bundle          # CLIP features + previews
       ↓
match import --data bundle/embeddings.json          # → SQLite
       ↓
match serve                                         # duel UI at 127.0.0.1:4576
       ↓
match train --name my-eye --out ~/.shoots/profiles/my-eye.json
       ↓
shoots rate <new-shoot> --profile my-eye            # your eye, on new work
```

---

## Why `match` lives outside the CLI

`match` is a **separate tool** in `tools/match` — its own `package.json`, its own
build, not part of the monorepo workspaces.

`shoots` is the feature extractor: it is the only place with CLIP and
onnxruntime. `match` only ever touches numeric embeddings and image files for the
UI. Keeping it out of `packages/*` keeps it off the CLI's dependency graph and out
of the single binary.

| | |
| --- | --- |
| **Runtime deps** | `express` and `commander` (both MIT) |
| **Storage** | Node's built-in `node:sqlite` — no native build, no dependency |
| **Requires** | **Node ≥ 22.5** (for `node:sqlite`) |
| **Never loads** | onnxruntime |
| **License** | PolyForm-Noncommercial-1.0.0, inherited from the repo |

---

## Step 1 — Export embeddings

```sh
shoots embeddings ~/Pictures/my-best-work --out ./bundle
```

```
Wrote bundle to ./bundle: embeddings.json + 1204 previews in previews/ (dim 512)
```

The **bundle** form matters for RAW: originals are not browser-viewable, so the
bundle carries JPEG previews the duel UI can display.

| Your source | Recommended |
| --- | --- |
| RAW | `--out <dir>` — previews are generated automatically (`--previews auto`) |
| JPEG | `--out <dir>` still works; the UI serves the originals directly |
| Huge JPEGs | `--out <dir> --previews always --preview-size 1024` to keep the UI snappy |
| Non-visual consumer | `--json > dataset.json` |

The export is deliberately **profile-neutral** — see
[`embeddings`](./commands/embeddings.md). If it inherited a preset's bias, you
would be training on that preset instead of on yourself.

### How many photos?

Aim for a few hundred to a few thousand, and make them **representative of the
work you want judged**. A set of only your portfolio keepers teaches the model
that everything is good; include the mediocre and the bad.

---

## Step 2 — Build `match`

```sh
cd tools/match
npm install
npm run build
```

Or run from source during development:

```sh
npm run dev -- import --data ../../bundle/embeddings.json
```

---

## Step 3 — Import into SQLite

```sh
match import --data ../../bundle/embeddings.json
```

| Option | Default | Description |
| --- | --- | --- |
| `--data <file>` | **required** | `embeddings.json` from `shoots embeddings` |
| `--images <dir>` | — | Base folder for resolving image paths in the UI |
| `--db <file>` | `./match.db` | SQLite database file |

Import is **idempotent on path**: re-running it after adding photos merges the new
ones without losing your existing duels.

Preview paths inside a bundle are resolved relative to `embeddings.json`, so the
bundle stays movable.

---

## Step 4 — Duel

```sh
match serve
```

```
Duel UI at http://127.0.0.1:4576
```

| Option | Default | Description |
| --- | --- | --- |
| `--db <file>` | `./match.db` | SQLite database file |
| `--port <n>` | `4576` | Port |
| `--host <host>` | `127.0.0.1` | Host — **local by default** |

Two photos, side by side.

| Input | Action |
| --- | --- |
| `←` / `→` or click | Keep that one |
| `space` | Skip the pair |

### Active learning

Pairs are not random. The strategy picks the **least-compared photo** against its
**closest current rival**, seeded from the neutral CLIP aesthetic
(`aestheticSeed`). Each duel therefore carries close to the maximum information —
you spend your attention where the model is genuinely uncertain, not confirming
what it already knows.

### How many duels?

- **~200** — a first usable signal.
- **~500–800** — where profiles typically start behaving sensibly.
- **More is better**, with diminishing returns.

Duels are cheap: a few hundred is fifteen minutes. Judge quickly and instinctively
— your first reaction is the signal you want to capture. Overthinking a pair adds
noise, and `space` is always available.

---

## Step 5 — Train

```sh
match train --name my-eye --out ~/.shoots/profiles/my-eye.json
```

| Option | Default | Description |
| --- | --- | --- |
| `--name <name>` | **required** | Profile name |
| `--out <file>` | **required** | Output profile JSON path |
| `--db <file>` | `./match.db` | SQLite database file |
| `--lambda <n>` | `1` | Ridge regularization strength |
| `--holdout <frac>` | `0.2` | Fraction of duels held out for accuracy measurement |

Four stages:

1. **Bradley-Terry** latent scores over the duel outcomes — a global ranking from
   pairwise comparisons.
2. A **ridge linear head** on the embeddings, so *unseen* photos get a score. This
   is what makes the profile generalize rather than memorize.
3. **Percentile star calibration** — placing the 0–5 boundaries so the
   distribution matches your actual keeper rate.
4. A **held-out pairwise-accuracy check**.

### Reading the accuracy

The held-out accuracy is the fraction of unseen duels the model predicts
correctly.

| Accuracy | Reading |
| --- | --- |
| `~0.50` | Chance. Not learning — too few duels, or inconsistent judgements. |
| `0.60–0.70` | Real signal. Usable. |
| `0.70–0.80` | Good. The profile meaningfully reflects your taste. |
| `> 0.85` | Suspiciously high on a small set — check you have enough held-out duels. |

Human preference on photographs is genuinely noisy: you will not agree with
*yourself* 100% of the time on a rerun. Do not expect 0.95.

Low accuracy? More duels first. Then check whether your set spans genuinely
different genres — a single linear head cannot be both a street eye and a
wildlife eye at once. Train separate profiles per genre.

### Tuning `--lambda`

Higher = more regularization = a smoother, more conservative profile. Raise it if
the profile behaves erratically on new work (overfitting); lower it if it is bland
and ignores your judgements.

---

## Step 6 — Use it

```sh
shoots rate ./new-shoot --profile my-eye --write-xmp
```

`--profile my-eye` resolves to `~/.shoots/profiles/my-eye.json` — that is why
`--out` pointed there. From any other location, copy the file in:

```sh
cp my-eye.json ~/.shoots/profiles/
```

Built-in names win over user profiles, so do not name yours `street`.

---

## The deliverable

A `type: "linear-embedding"` profile whose field names mirror the `shoots`
`RatingProfile` shape — a flat focus gate plus `aestheticStars`. `embeddingModel`
guards that the profile is only ever applied to the CLIP space it was learned on.

Full schema in [Rating profiles](./profiles.md#the-linear-embedding-shape).

---

## Practical notes

- **RAW workflows need the bundle.** Use `shoots embeddings --out <dir>` so JPEG
  previews exist. A plain `--json` dataset points at the originals, which only
  render in a browser if they are themselves viewable.
- **The DB is your work.** `match.db` holds every duel you have judged. Back it
  up. You can retrain from it any number of times with different `--lambda`
  values without re-judging anything.
- **Train per genre.** One profile cannot be simultaneously a street eye and a
  wildlife eye. Separate databases, separate profiles.
- **Re-import to grow.** Add photos, re-run `shoots embeddings` and
  `match import`; existing duels survive.
- **Re-train freely.** Training is fast and reads only the DB.

---

## Complete worked example

```sh
# ── 1. Features ───────────────────────────────────────────────────────────────
shoots embeddings ~/Pictures/street-2020-2026 --out ~/work/street-bundle

# ── 2. Tool ───────────────────────────────────────────────────────────────────
cd tools/match && npm install && npm run build

# ── 3. Import ─────────────────────────────────────────────────────────────────
node dist/cli.js import \
  --data ~/work/street-bundle/embeddings.json \
  --db ~/work/street.db

# ── 4. Duel — judge ~600 pairs, then Ctrl-C ───────────────────────────────────
node dist/cli.js serve --db ~/work/street.db

# ── 5. Train ──────────────────────────────────────────────────────────────────
node dist/cli.js train \
  --db ~/work/street.db \
  --name my-street-eye \
  --out ~/.shoots/profiles/my-street-eye.json

# ── 6. Apply to a new shoot ───────────────────────────────────────────────────
shoots rate ~/Shoots/2026-07-rome --profile my-street-eye --write-xmp

# ── 7. Sanity-check against the built-in prior ────────────────────────────────
diff <(shoots rate ~/Shoots/2026-07-rome --profile street        --dry-run --json | jq -r '.results[]|"\(.stars) \(.file)"') \
     <(shoots rate ~/Shoots/2026-07-rome --profile my-street-eye --dry-run --json | jq -r '.results[]|"\(.stars) \(.file)"')
```

---

## See also

- [`embeddings`](./commands/embeddings.md) — the export command in full
- [Rating profiles](./profiles.md) — the profile format and the built-in priors
- [`rate`](./commands/rate.md) — applying a profile
- `tools/match/README.md` — the tool's own documentation
