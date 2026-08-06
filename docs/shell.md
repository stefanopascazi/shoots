# Interactive shell

Running `shoots` with **no arguments** on a terminal opens a fullscreen
interactive shell.

```
  ███████╗██╗  ██╗ ██████╗  ██████╗ ████████╗███████╗
  ██╔════╝██║  ██║██╔═══██╗██╔═══██╗╚══██╔══╝██╔════╝
  ███████╗███████║██║   ██║██║   ██║   ██║   ███████╗
  ╚════██║██╔══██║██║   ██║██║   ██║   ██║   ╚════██║
  ███████║██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████║
  ╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝
  ◉ v0.4.1 — batch automation for photographers

❯ /cull @raw/ --dest @rejects/ --review
```

You can also open it explicitly with `shoots shell`.

> **It only activates on a TTY.** In a pipe, a cron job or CI, `shoots` with no
> arguments prints help instead, and every batch command works unchanged. Scripts
> are unaffected.

---

## Why use it

- **Discovery** — `/` lists every command with its usage line. No `--help` round
  trips.
- **Path completion** — `@` completes files and folders as you type. This is the
  single biggest time-saver when working with deep catalog trees.
- **`cull --review`** — the interactive triage UI lives here and nowhere else.
- **Session context** — `/cd` once, then run short relative commands.

---

## How it behaves

### Alternate screen buffer

The shell runs in the terminal's **alternate screen buffer**, the same mechanism
`vim` and `less` use. It takes over a clean fullscreen, and on exit your previous
terminal content is restored **exactly** as it was — no scrollback pollution.

### Pinned input

The input line is pinned to the bottom. Command output scrolls in the shell's own
history above it, so you always know where to type.

### Real child processes

Commands run in a child process with live output streaming. Behaviour is
**identical to batch mode** — same flags, same output, same exit codes. The shell
is a front end, not a different implementation.

---

## The `/` command palette

Type `/` to open autocomplete.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Navigate the suggestions |
| `Tab` | Accept the highlighted suggestion |
| *(keep typing)* | Filter the list |

Every CLI command is present, plus shell-only builtins. A usage hint appears under
the input as you type:

```
❯ /cull
  /cull <path> [--review] [--mark] [--mark-label reject] [--mark-keepers select]
        [--dest <dir>] [--copy] [--threshold 100]
        [--focus-threshold 250] [--no-focus-rescue] [--format csv] [--out <report>] [--dry-run]
```

> The catalog is checked against the real command list at every startup. A command
> that exists on the CLI but is missing from the shell fails loudly at launch — so
> the palette can never silently drift out of date.

---

## `@` path mentions

Type `@` to complete filesystem paths.

```
❯ /cull @ra
              ┌────────────────────────┐
              │ raw/                   │
              │ raw-backup/            │
              └────────────────────────┘
```

- Completions are capped at **6 entries**, with a `+N more` hint when there are
  additional matches.
- Paths with spaces are quoted: `@"my folder/"`.
- Mentions **expand to plain paths** before execution — the command receives an
  ordinary argument.

```
❯ /cull @raw/ --dest @rejects/
   ↓ executes as
   shoots cull raw/ --dest rejects/
```

---

## Keyboard reference

| Key | Action |
| --- | --- |
| `/` | Open the command palette |
| `@` | Open path completion |
| `↑` / `↓` | Command history (or navigate suggestions when open) |
| `Tab` | Accept the highlighted suggestion |
| `Esc` | Clear the input — or **cancel a running command** |
| `Ctrl-C` | Interrupt |
| Mouse wheel | Scroll the output history |

`Esc` is the important one: it cancels a long-running cull or rate without leaving
the shell.

---

## Builtins

Handled inside the shell rather than spawning the CLI:

| Command | Purpose |
| --- | --- |
| `/cd <path>` | Change the shell working directory |
| `/pwd` | Print the working directory |
| `/clear` | Clear the screen |
| `/mouse` | Toggle mouse capture |
| `/help` | Show commands and shell tips |
| `/version` | Show the `shoots` version |
| `/exit` | Leave the shell |

### `/mouse` — the one you will want

The alternate screen buffer disables your terminal's native scrolling, so the
shell captures the mouse wheel to provide its own scrollback.

The side effect: **while mouse capture is on, you cannot select and copy text** —
the terminal never sees the drag.

```
❯ /mouse        # capture off → select and copy normally
❯ /mouse        # capture on  → wheel scrolls the history again
```

Toggle it off when you need to copy a path or an error message out of the output.

---

## `cull --review` — the shell-only mode

The interactive triage UI requires the shell. In batch mode it exits `2` and tells
you so.

```
❯ /cull ./catalog --review --mark            # record the verdicts, move nothing
❯ /cull ./catalog --review --dest ./rejects  # relocate the rejects
```

The flow respects your time:

1. Focus-aware analysis runs over the whole folder.
2. **Confident rejects are disposed of immediately** — marked or relocated,
   depending on which of the two you passed. Keepers stay put either way.
3. You are handed *only* the uncertain shallow-DoF rescues, one card at a time.

Each card shows the global score, the focus peak, the aperture, and a **focus
heatmap** with a legend (soft → sharp) marking where focus actually landed.

| Key | Action |
| --- | --- |
| `K` | **Keep** — the file stays where it is |
| `D` | **Discard** — mark it, or relocate it to `--dest` |
| `P` | **Preview** — open the frame in your system image viewer |
| `S` | **Skip** — decide later |
| `Esc` | Finish the review |

- **`--mark` or `--dest` is required** — the discards have to go somewhere, or be
  recorded somewhere. With `--mark` nothing moves and `/triage apply` (or
  `/develop edit`) writes the labels out later.
- `--copy` copies instead of moving. Only meaningful with `--dest`.
- `--dry-run` walks the entire flow without touching a file. Use it to learn the
  interface.

Full details: [`cull`](./commands/cull.md#interactive-review---review).

---

## A session

```
❯ /cd D:/Shoots/2026/smith-wedding
D:\Shoots\2026\smith-wedding

❯ /doctor
[✓] platform     win32/x64, node v22.11.0
...
9 checks: 9 ok, 0 warnings, 0 failed

❯ /import E:/DCIM/100CANON --dest @raw/ --dry-run
copy  E:\DCIM\100CANON\IMG_0001.CR3  →  D:\Shoots\2026\smith-wedding\raw\2026\2026-07-19\IMG_0001.CR3
...
(dry run) 482 files would be copied

❯ /import E:/DCIM/100CANON --dest @raw/
482/482 files copied to D:\Shoots\2026\smith-wedding\raw

❯ /exif @raw/ --set-artist "Jane Doe Photography" --set-keywords wedding,smith
Wrote 3 tags to 482 files (482 image files updated)
Originals preserved as *_original backups (exiftool default).

❯ /cull @raw/ --review --mark
  … 38 confident rejects marked 'reject'; 13 uncertain frames to review …
  [K] keep  [D] discard  [P] preview  [S] skip  [Esc] finish

❯ /rate @raw/ --profile wedding --mark
★★★★☆  IMG_0001.CR3  focus=0.812 aesthetic=0.591  [wedding, ceremony]
...
431/431 rated with onnx-clip/vit-b32-int8-2 (profile: wedding)
marked 431 files — `shoots develop edit` or `shoots triage apply` writes them into sidecars

❯ /triage apply @raw/
  431 sidecar(s) written in acr vocabulary; the marks are now applied

❯ /exit
◉ shoots — session closed. See you at the next shoot.
```

---

## Notes

- **Requires a TTY on both stdin and stdout.** `shoots shell` in a pipe exits `2`
  with a clear message.
- **The terminal is always restored.** Alt-screen and mouse mode are torn down on
  exit — including on crash — via a process-exit safety net. You cannot be left
  with a stuck terminal.
- **No hidden state.** The shell does not maintain a session beyond the working
  directory and command history. Every command is a fresh, identical child
  process.

---

## See also

- [`cull`](./commands/cull.md) — including the review mode in detail
- [Command reference](./commands/README.md) — every command works here too
