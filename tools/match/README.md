# shoots-match

Personal preference-learning tool for [Shoots](../../README.md). You duel your own
photos two at a time ("keep this one, drop that one"); the outcomes train a
**linear-embedding rating profile** that generalizes *your* eye to new photos.

It is deliberately **separate from the Shoots monorepo**: its own `package.json`,
its own build, its own (optional) CI. It never loads onnxruntime — it consumes the
CLIP embeddings that Shoots already extracts.

## Why it lives outside the CLI

Shoots is the feature extractor (the only place with CLIP/onnx). This tool only
touches numeric embeddings and image files for the UI. Keeping it out of
`packages/*` keeps it off the CLI's dependency graph and out of the single binary.

Licensed **PolyForm-Noncommercial-1.0.0** (inherited from the repo): fine for
personal training, not for commercial redistribution. Storage uses Node's built-in
`node:sqlite` (no native build, no dependency); the only runtime deps are
`express` and `commander` (both MIT). Requires **Node ≥ 22.5** for `node:sqlite`.

## Pipeline

```
shoots embeddings <my-photos> --json > dataset.json     # in the Shoots CLI
match import --data dataset.json --images <my-photos>    # → SQLite
match serve                                              # duel UI at http://127.0.0.1:4576
match train --name street --out profiles/street.json     # → the deliverable
```

- **import** — loads a `shoots embeddings` dataset into SQLite. Idempotent on path.
- **serve** — two photos side by side; `←`/`→` or click to keep one, `space` to skip.
  Pairs are chosen by active learning (least-compared photo vs its closest rival in
  the current estimate), seeded from the neutral CLIP aesthetic.
- **train** — Bradley-Terry latent scores over the duels, a ridge linear head on the
  embeddings (so unseen photos get a score), percentile star calibration, and a
  held-out pairwise-accuracy check. Emits the profile JSON.

## The deliverable

A `type: "linear-embedding"` profile whose field names mirror the Shoots
`RatingProfile` (flat focus gate + `aestheticStars`), so a future Shoots loader
only has to add the `linear-embedding` branch. `embeddingModel` guards that the
profile is applied to the same CLIP space it was learned on.

## Notes

- The UI displays browser-viewable images (JPEG/PNG/WebP/…). RAW originals won't
  render — point `shoots embeddings` at exported previews/JPEGs for the duels.
- Default DB is `./match.db` (override with `--db`).

## Develop

```
npm install
npm run dev -- import --data ../../dataset.json   # run from source (tsx)
npm run build && npm start -- serve               # compiled
```
