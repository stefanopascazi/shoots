# shoots for Lightroom Classic

A Lightroom Classic plug-in that runs `shoots` on the selected photos and
writes the result straight into the catalog — no sidecars.

| Menu item (Library > Plug-in Extras, or File > Plug-in Extras) | What it does |
| --- | --- |
| Cull Selection (flag blurry as rejected) | `pickStatus = -1` on every blurry frame; sharp frames keep their flag |
| Rate Selection | a 0–5 star rating, using the profile set in the Plug-in Manager |
| Install or Update shoots | installs the binary when missing, otherwise runs `shoots update` |
| Download Dependencies | runs `shoots setup` (exiftool, raw decoder, inference model) |

Each run is one undo step (Edit > Undo). Virtual copies share their master's
file, so all of them receive the same change. A progress bar follows the CLI
through scanning, per-photo work and downloads.

The Plug-in Manager panel shows the installed version and carries the same
Install/Update and Download Dependencies buttons.

The app runs only through this plug-in. Its server (the hidden `shoots app`)
binds 127.0.0.1, accepts only the session token from `~/.shoots/app.json`, and
stops when the plug-in stops renewing its lease: when Lightroom quits, crashes,
or "Close shoots" is chosen.

While the app is open, the plug-in checks it every few seconds. What you send
from the app with **Send to Lightroom** (ratings, rejects, your Keep decisions)
is written into the catalog as one undo step, "shoots: Apply from the app" —
no sidecars. Photos the catalog does not have are reported back to the app.

## Requirements

- Lightroom Classic 6 or later.
- Nothing else up front. On first use the plug-in offers to install the
  `shoots` binary by running the official installer (`install.ps1` /
  `install.sh`: download, SHA-256 check) into `~/.shoots/bin`, or into the
  folder of a custom path set in the Plug-in Manager. A download made this way
  carries no Mark-of-the-Web / quarantine flag, so no SmartScreen or Gatekeeper
  prompt.
- A built plug-in needs a CLI at least as new as itself and offers to update
  an older one. The development copy (version 0.0.0) accepts any CLI.

## Develop: load the source folder

1. File > Plug-in Manager > **Add**.
2. Choose `plugins/lightroom/shoots.lrdevplugin`.

Lightroom reads the folder in place: after editing a `.lua` file, use
**Reload Plug-in** in the Plug-in Manager.

## Export: build a distributable plug-in

```sh
npm run build:lrplugin
```

Produces, with the version from the root `package.json` stamped into
`Info.lua`:

- `dist-plugin/shoots.lrplugin/` — the folder Lightroom loads;
- `dist-plugin/shoots-lightroom-<version>.zip` — the same folder, zipped.

To install: unzip anywhere permanent, then File > Plug-in Manager > **Add** and
pick `shoots.lrplugin`.

## How it talks to shoots

`Runner.lua` writes the selection to a temporary list and runs
`shoots cull|rate --files-from <list> --json`, with stdout and stderr sent to
temporary files. `rate` also gets `--dry-run`, so the CLI writes no sidecar
beside the photographs: the catalog is the only target.

Progress travels through `SHOOTS_PROGRESS_FILE`: the CLI appends JSON lines,
and the plug-in polls the file every 0.3 s from a second task, because
`LrTasks.execute` returns only when the process exits.

## Layout

| File | Role |
| --- | --- |
| `Info.lua` | Manifest and menu items |
| `Action.lua` | Shared flow: selection → run → one catalog write |
| `Runner.lua` | Locates the binary, runs it, follows its progress, decodes the report |
| `Installer.lua` | Install, update, `setup`, and the pre-run readiness check |
| `CullSelection.lua`, `RateSelection.lua`, `InstallOrUpdate.lua`, `SetupDependencies.lua` | Menu entry points |
| `PluginInfoProvider.lua` | Plug-in Manager panel (binary path, rating profile) |
| `Json.lua`, `Command.lua`, `Results.lua`, `Progress.lua`, `Version.lua` | Pure Lua, no Lightroom imports — unit tested |
| `PluginVersion.lua` | The CLI version this build requires, stamped by the build |

## Tests

`plugins/lightroom/test` runs the pure modules under
[fengari](https://github.com/fengari-lua/fengari) (MIT, dev only), compiles
every file, and builds the package. Part of `npm run test:unit`.
