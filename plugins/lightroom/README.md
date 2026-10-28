# shoots for Lightroom Classic

A Lightroom Classic plug-in that runs `shoots` on the selected photos and
writes the result straight into the catalog — no sidecars.

| Menu item (Library > Plug-in Extras, or File > Plug-in Extras) | What it writes |
| --- | --- |
| Cull Selection (flag blurry as rejected) | `pickStatus = -1` on every blurry frame; sharp frames keep their flag |
| Rate Selection | a 0–5 star rating, using the profile set in the Plug-in Manager |

Each run is one undo step (Edit > Undo). Virtual copies share their master's
file, so all of them receive the same change.

## Requirements

- Lightroom Classic 6 or later.
- The `shoots` binary, installed by `install.ps1` / `install.sh` into
  `~/.shoots/bin`. A different location can be set in the Plug-in Manager.

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

## Layout

| File | Role |
| --- | --- |
| `Info.lua` | Manifest and menu items |
| `Action.lua` | Shared flow: selection → run → one catalog write |
| `Runner.lua` | Locates the binary, runs it, decodes the report |
| `CullSelection.lua`, `RateSelection.lua` | Menu entry points |
| `PluginInfoProvider.lua` | Plug-in Manager panel (binary path, rating profile) |
| `Json.lua`, `Command.lua`, `Results.lua` | Pure Lua, no Lightroom imports — unit tested |

## Tests

`plugins/lightroom/test` runs the pure modules under
[fengari](https://github.com/fengari-lua/fengari) (MIT, dev only), compiles
every file, and builds the package. Part of `npm run test:unit`.
