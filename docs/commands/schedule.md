# `shoots schedule`

Hand the daily [`develop refine`](./develop.md#shoots-develop-refine) to the
machine's own scheduler, so the develop predictor keeps learning without anybody
remembering to run it.

```
shoots schedule <install|status|uninstall|run> [options]
```

| Subcommand | Purpose |
| --- | --- |
| [`install`](#shoots-schedule-install) | Register the daily job (re-run to change the time) |
| [`status`](#shoots-schedule-status) | What the OS holds, and which shoots the next run would refine |
| [`uninstall`](#shoots-schedule-uninstall) | Remove it |
| [`run`](#shoots-schedule-run) | Do a pass now — this is what the scheduler calls |

The reason this exists: `refine` is the step that pays off *next month*. It folds
a shoot you have just developed back into the model, and skipping it costs
nothing tonight — so it is the step that gets skipped. A daily job costs nothing
either, and the work only happens when there is work to do.

---

## Why the OS scheduler, and not a daemon

`shoots` ships no background service. cron and the Windows Task Scheduler already
solve the parts that are genuinely hard — surviving a reboot, catching up after
the machine was asleep, running as the right user — and a daemon of our own would
be one more process to supervise, update and explain.

| Platform | Backend | Where it lives |
| --- | --- | --- |
| Linux, macOS | `cron` | The **user** crontab, between two marker comments |
| Windows | Task Scheduler | A registered task named `Shoots Develop Refine` |
| anything else | none | `schedule run` is the whole job — call it yourself |

Both backends run as **you**, not as root or a service account: the job reads your
catalog and writes into your `~/.shoots`.

---

## The job takes no paths

This is the part worth understanding before trusting it.

`shoots schedule install` does **not** record a list of folders. The registered
command line is exactly:

```
/path/to/shoots schedule run
```

Every night that run re-reads the shoots still cached under
`~/.shoots/develop/export/shooting/` — one working directory per shoot that
`develop edit` has touched — and recovers each shoot's folder from the absolute
paths inside its own `prediction.json`. Nothing to keep in sync, and nothing to go
stale: a shoot that has been moved, renamed, deleted or dropped by
[`develop clean`](./develop.md#shoots-develop-clean) simply stops appearing.

A shoot is passed over, with the reason, when:

| Reason | Meaning |
| --- | --- |
| `working files incomplete` | No `prediction.json` or no `export.jsonl` — `develop edit` never finished here |
| `the shoot folder is gone` | Moved, renamed or deleted since `develop edit` |
| `none of the photographs are still there` | The folder is there, its contents are not |
| `unchanged since the last refine` | Nothing has been edited since the last pass — see below |

---

## Why "unchanged" is skipped, and why it matters

`develop refine` is idempotent about the **data** it stores. Both the feedback
journal and the training dataset are keyed by absolute file path, newest wins, so
a second pass over an untouched shoot adds no rows and duplicates no photograph.
Nothing is "reintroduced".

It is **not** idempotent about the state around them, and an unattended nightly
re-run is exactly the thing that would expose that:

- `learn` marks every photograph it folds in as `trainedOn`. On the next pass
  `feedback` sees an already-trained photograph and flags its observation
  `inSample` — and `calibrate` skips in-sample observations. The clean held-out
  measurement recorded on the first pass gets overwritten by an identical pair
  carrying that flag, and the shoot is lost as calibration evidence for good.
- `learn` refits, and a refit writes a whole new profile — which discards the
  calibration offsets measured against the old one.

So a nightly re-run of an unchanged shoot would slowly strip a catalog of the
evidence it needs, in exchange for no new information at all. The guard is a
fingerprint of what `refine` actually reads — each photograph and its sidecar, by
size and modification time — kept in `refine-state.json` beside the shoot's
working files. It is cheap (one `stat` per file, no exiftool, no pixels) and it
moves for exactly the edits that would give `refine` something new to measure.

The fingerprint is recorded **whether the refine succeeded or not**, deliberately:
a shoot nobody has developed yet fails the same way every night, and "something
changed on disk" is the only useful trigger for trying again.

`shoots schedule run --force` overrides the guard.

---

## `shoots schedule install`

```
shoots schedule install [--at HH:MM] [--dry-run] [--json] [--verbose]
```

| Option | Default | Description |
| --- | --- | --- |
| `--at <HH:MM>` | `03:00` | Local wall-clock time to run at |
| `--dry-run` | off | Print the job that would be registered, register nothing |

Re-running it **replaces** the existing job rather than adding a second one, so
changing the time is just `install --at` again.

```sh
shoots schedule install --at 02:30
```

```
Registered with Windows Task Scheduler: `develop refine` daily at 02:30.
  job  C:\Users\you\.shoots\bin\shoots.exe schedule run

It refines whichever shoots are still cached under C:\Users\you\.shoots\develop when it
wakes up — nothing is baked into the schedule, so moving or cleaning a shoot
simply takes it out. A shoot nobody has touched since the last pass is skipped.

Right now that is 1 shoot(s) due of 3 cached.
```

If `SHOOTS_HOME` is set when you install, it is baked into the job as
`--home <dir>`. cron and the Task Scheduler both start from an environment that
has never seen your shell profile, so a job that silently used the default
`~/.shoots` while every interactive command used your override would refine
nothing and explain nothing.

### Platform notes

**macOS** — cron needs **Full Disk Access** (System Settings → Privacy &
Security) for `/usr/sbin/cron` if your photographs live under Desktop, Documents,
Downloads or an external volume. Without it the job runs and sees an empty folder.
cron also does not wake a sleeping Mac: a missed run is skipped, not queued.

**Windows** — the task is registered with an interactive token and no stored
password, so it needs no administrator to install and it only fires while you are
logged on. A run missed because the machine was off or asleep starts as soon as it
is available.

**Running from source** — a job registered from a `node`/`bun` checkout points at
`dist/cli.js`. `install` says so; re-run it after moving or rebuilding.

---

## `shoots schedule status`

```
shoots schedule status [--json]
```

```
Scheduler         cron (user crontab)
Daily job         02:30
                  '/home/you/.shoots/bin/shoots' 'schedule' 'run' >/dev/null 2>&1

Cached shoots     3
  2026-07-19                   due
                               /home/you/Shoots/2026-07-19  84/84 files present
                               last refine 2026-07-24T02:30:11.402Z (refined)
  2026-07-11                   skip · unchanged since the last refine
                               /home/you/Shoots/2026-07-11  120/120 files present
                               last refine 2026-07-12T02:30:44.980Z (refined)
  2026-06-28                   skip · the shoot folder is gone (moved, renamed or deleted)
                               /home/you/Shoots/2026-06-28  0/61 files present
```

The command line is shown as the OS holds it, verbatim — including cron's shell
quoting and its `>/dev/null` (the run keeps its own log; see below).

---

## `shoots schedule uninstall`

```
shoots schedule uninstall [--json]
```

Removes the job and nothing else: the profile, the feedback journal, the cached
shoots and their `refine-state.json` all survive, and
`shoots develop refine <shoot>` still works by hand. Exits `0` when there was
nothing registered.

On Linux and macOS only the marked block is cut out of the crontab; everything
you put there yourself is written back untouched.

---

## `shoots schedule run`

```
shoots schedule run [--force] [--editor <id>] [--home <dir>]
                    [--dry-run] [--json] [--verbose]
```

| Option | Default | Description |
| --- | --- | --- |
| `--force` | off | Refine every cached shoot, including the unchanged ones |
| `--editor <id>` | `acr` | Which editor's develop settings to read |
| `--home <dir>` | — | Shoots home to use; the installed job passes the one it was installed with |
| `--dry-run` | off | Report what would run, refine nothing |

Worth running by hand once — `--dry-run` first — before trusting it to the
scheduler.

Each shoot is refined as a **child process**, which matters in something nobody is
watching: one shoot that throws cannot take the rest of the night with it, its
exit code is the unambiguous verdict on that shoot, and its full report can be
captured verbatim instead of interleaved with everyone else's.

### The log

Every pass appends to `~/.shoots/logs/schedule.log`, including the complete
`refine` transcript for each shoot it touched, and rotates to `schedule.log.1`
past 5 MB.

```
=== 2026-07-24T02:30:04.112Z - 1 of 3 cached shoot(s) due
--- 2026-07-11: skipped (unchanged since the last refine)
--- 2026-06-28: skipped (the shoot folder is gone (moved, renamed or deleted))
--- 2026-07-19: exit 0 (/home/you/Shoots/2026-07-19)
[… the full feedback / learn / calibrate report …]
=== done: 1 refined, 0 failed, 2 skipped
```

The scheduled job discards its own stdout and stderr, because this log is better:
left alone, cron would mail a full refine report every night to a machine where
nobody reads local mail.

---

## JSON output

```json
{
  "command": "schedule-status",
  "backend": "cron",
  "supported": true,
  "error": null,
  "schedule": {
    "installed": true,
    "at": "02:30",
    "command": "'/home/you/.shoots/bin/shoots' 'schedule' 'run' >/dev/null 2>&1"
  },
  "shoots": [
    {
      "shoot": "2026-07-19",
      "source": "/home/you/Shoots/2026-07-19",
      "workDir": "/home/you/.shoots/develop/export/shooting/2026-07-19",
      "files": 84,
      "present": 84,
      "due": true,
      "lastRefine": {
        "at": "2026-07-24T02:30:11.402Z",
        "fingerprint": "bc08094d…",
        "outcome": "refined",
        "exitCode": 0
      }
    }
  ]
}
```

`schedule run --json`:

```json
{
  "command": "schedule-run",
  "at": "2026-07-24T02:30:04.112Z",
  "log": "/home/you/.shoots/logs/schedule.log",
  "refined": 1,
  "failed": 0,
  "skipped": 2,
  "shoots": [
    { "shoot": "2026-07-19", "source": "/home/you/Shoots/2026-07-19", "status": "refined", "exitCode": 0 },
    { "shoot": "2026-07-11", "source": "/home/you/Shoots/2026-07-11", "status": "skipped", "reason": "unchanged since the last refine" }
  ]
}
```

---

## Exit codes

| Code | When |
| --- | --- |
| `0` | Registered, removed, reported — or a run in which nothing failed |
| `1` | The scheduler refused the job, or at least one shoot's refine failed |
| `2` | Bad `--at`, unknown `--editor`, no backend for this platform, or no profile to refine against |

---

## See also

- [`shoots develop`](./develop.md) — the pipeline this automates, and `refine` itself
- [Develop predictor guide](../develop-predictor.md) — what is being learned, and why the loop matters
- [Configuration](../configuration.md) — `SHOOTS_HOME`
