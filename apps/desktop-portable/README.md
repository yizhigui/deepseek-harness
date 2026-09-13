# DeepSeek Harness Desktop add-on targets

This directory holds **only additive desktop packaging code** for the official Electron desktop
application that already lives in [`apps/desktop`](../desktop). It does not fork, copy, or replace
the shell, the bundled runtime, or any Harness source.

## Why this directory exists

`apps/desktop` is the official Electron shell and already owns the real work: it starts the bundled
Harness backend as a managed child process, waits for readiness, and serves the Web UI. Its Windows
target is NSIS only (`win.target === ['nsis']` in `apps/desktop/electron-builder.config.mjs`).

This directory adds the extra targets requested for local desktop distribution without editing that
config:

1. a **portable** `.exe`, alongside the existing NSIS installer;
2. output written to `dist-desktop/`;
3. a builder cache location on the same volume as the build scratch directory.

## The `EXDEV` problem this fixes

`electron-builder` downloads its NSIS and 7-Zip toolsets into
`%LOCALAPPDATA%\electron-builder\Cache` and extracts each archive into a `.tmp` sibling before
renaming it into place. When the build scratch directory sits on another volume, that final
`rename` crosses devices and fails:

```
EXDEV: cross-device link not permitted, rename
  'C:\Users\<user>\AppData\Local\electron-builder\Cache\7zip@1.0.0\7zip-win-x64-a34pt.tmp'
  -> '...\7zip-win-x64-a34pt'
```

Both scripts here set `ELECTRON_BUILDER_CACHE` to a directory next to the build output, so the
download, its temporary sibling, and its final name always share one volume.

## Scripts

Requires the artifacts that `pnpm run package:desktop:win:x64:unsigned` has already prepared under
`apps/desktop/.desktop-build/targets/win-x64/`, and an already packed application directory.

```powershell
# From the repository root.
# Build the full installer + portable exe from the unpacked application.
pnpm --dir apps/desktop-portable exec node scripts/package-portable.mjs win-x64

# Only the portable exe.
pnpm --dir apps/desktop-portable exec node scripts/package-portable.mjs win-x64 --portable-only
```

`node_modules` in this directory links the workspace `electron-builder`, `app-builder-lib`, and
`electron` exactly as `apps/desktop` resolves them, so no extra install step is required.

## Relationship to the official shell

| Concern | Owner |
|---|---|
| Electron main process, preload, windows, IPC, protocol | `apps/desktop` (unchanged) |
| Backend child-process lifecycle and readiness | `apps/desktop` (unchanged) |
| Bundled Node.js, pnpm, and the production Harness tree | `apps/desktop` (unchanged) |
| NSIS installer configuration | `apps/desktop` (unchanged) |
| Extra `portable` target, `dist-desktop/` output, builder cache location | this directory |

`scripts/portable-targets.mjs` imports the official config factory
(`apps/desktop/electron-builder.config.mjs`) and only appends a target, so upgrade, runtime
verification, and signing configuration keep flowing from the official single source of truth.
