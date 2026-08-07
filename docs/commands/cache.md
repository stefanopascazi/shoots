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

Derived values, and only derived values: a Laplacian measurement with its focus
map, and the CLIP image embedding. **Never image data.** That distinction is why
the cache is safe to leave on:

| | 100,000 RAW frames |
| --- | --- |
| the catalog itself | ~2.5 TB |
| its embedded previews, if they were cached | ~300 GB |
| **the derived numbers, which is what is cached** | **~420 MB** |

The expensive part was never the bytes. Decoding a full-size preview, running a
Laplacian over it and pushing it through CLIP costs about 320 ms per frame; what
falls out is about 4 KB. A hit skips the decode and reads the four kilobytes.

## Which commands share it

| Command | Reads / writes |
| --- | --- |
| [`cull`](./cull.md), `/cull --review` | the sharpness measurement |
| [`rate`](./rate.md) | the embedding **and** the sharpness |
| [`embeddings`](./embeddings.md) | the embedding |
| [`develop export`](./develop.md) (so `init` and `edit`) | the embedding |

They share entries in both directions. `rate` after `cull` skips the Laplacian;
`cull` after `rate` measures nothing at all, because the embedding pass already
had the pixels open and left its measurement behind. `embeddings` after `rate`
does no work whatsoever.

## What is *not* cached

Anything that depends on what you asked for.

`cull` caches its measurement and re-derives sharp-versus-blurry every run, so
hunting for the right `--threshold` costs one decode instead of one per attempt:

```sh
shoots cull ~/shoot                      # measures
shoots cull ~/shoot --threshold 400      # reclassifies, instant
shoots cull ~/shoot --threshold 250      # instant
```

`rate` caches the embedding and re-derives the stars, so a second opinion under
another eye is a dot product rather than a forward pass:

```sh
shoots rate ~/shoot --profile street     # embeds — 3.1s for 30 frames
shoots rate ~/shoot --profile portrait   # re-scores — 0.5s
shoots rate ~/shoot --profile my-eye     # 0.5s
```

Cached and uncached runs produce byte-identical output. If they ever did not,
that would be a bug and not a trade-off.

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

A frame carries about 1.5 KB of measurement and 2.7 KB of embedding, so a shoot
that has only been culled costs roughly a third of one that has been rated too.

---

## See also

- [`cull`](./cull.md), [`rate`](./rate.md), [`embeddings`](./embeddings.md) — the commands that fill it
- [Configuration](../configuration.md) — `SHOOTS_HOME`, `SHOOTS_CACHE`, `SHOOTS_CACHE_MAX`
