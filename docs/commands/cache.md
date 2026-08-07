# `shoots cache`

The numbers commands work out about a photograph, kept so the next command does
not work them out again.

```
shoots cache status
shoots cache clear
shoots cache prune
```

---

## What it holds

Derived values, and only derived values: a Laplacian measurement, a focus map,
and — as the predictor lands on it — CLIP embeddings and colour-feature vectors.
**Never image data.** That distinction is why the cache is safe to leave on:

| | 100,000 RAW frames |
| --- | --- |
| the catalog itself | ~2.5 TB |
| its embedded previews, if they were cached | ~300 GB |
| **the derived numbers, which is what is cached** | **~150 MB** |

The expensive part was never the bytes. Decoding a full-size preview and running
a Laplacian over it costs about 150 ms per frame; the measurement that falls out
is about 1.5 KB. A hit skips the decode and reads the kilobyte.

## What is *not* cached

The verdict. `cull` caches its measurement and re-derives sharp-versus-blurry
every run, so hunting for the right `--threshold` costs one decode instead of one
per attempt:

```sh
shoots cull ~/shoot                      # measures, ~2s per 40 frames
shoots cull ~/shoot --threshold 400      # reclassifies, instant
shoots cull ~/shoot --threshold 250      # instant
```

The same rule will apply to `rate`: the embedding is cached, the stars are
re-derived, so changing `--profile` will not re-run the model.

## Identity, and why a wrong answer is not possible

Every entry carries the size and modification time the scan reported for the
file. Disagree with either and the record is dropped whole, along with every
other value stored for that photograph — they all described the same pixels.

Renaming or moving a file *outside* `shoots` orphans its entry. That costs a
recomputation and nothing else. The failure mode of this cache is always
"measure it again", never "answer with the old number".

---

## `status`

```
shoots cache status [--json]
```

Where the cache lives, what it occupies, how many shoots it covers and how close
it is to its ceiling.

## `clear`

```
shoots cache clear [--json]
```

Drops everything. Nothing is lost but time — the next run measures from scratch.

## `prune`

```
shoots cache prune [--json]
```

Drops the oldest shoots until the cache fits under its ceiling. Runs
automatically at the end of any command that wrote to the cache, so this is for
when you have just lowered `SHOOTS_CACHE_MAX` and want it to take effect now.

---

## Turning it off

| How | Scope |
| --- | --- |
| `--no-cache` | One command run |
| `SHOOTS_CACHE=0` | Every command |
| `SHOOTS_CACHE_MAX=<size>` | The ceiling; default `1GB`. Accepts `512MB`, `2GB`, or plain bytes. |

Eviction is per shoot, oldest first, and never touches the shoot the running
command is using — evicting that would make every run a cold one.

---

## Layout

One JSONL file per **directory**, under `~/.shoots/cache/`. Per directory rather
than per command target on purpose: culling `shoot/day1` and then `shoot/` is the
same photographs, and keying on the folder you happened to type would miss every
one of them.

One file per shoot rather than one per photograph, also on purpose: a hundred
thousand small files is a hundred thousand filesystem records, cluster slack on
each, and a long afternoon for a virus scanner.

---

## See also

- [`cull`](./cull.md) — the first command to use the cache
- [Configuration](../configuration.md) — `SHOOTS_HOME`, `SHOOTS_CACHE`, `SHOOTS_CACHE_MAX`
