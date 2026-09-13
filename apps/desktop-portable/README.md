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

## Application icon

`apps/desktop/assets/` holds the icon set, built from artwork the repository already ships:

| File | Role |
|---|---|
| `icon-source.svg` | The one source file: official whale path, brand blue `#4D6BFE`, 1024x1024, transparent, safe margin |
| `icon.png` | 1024x1024 transparent raster |
| `icon.ico` | 16, 24, 32, 48, 64, 128, and 256 entries |

Regenerate all three from the official artwork with:

```sh
pnpm --dir apps/desktop-portable run icons
```

The generator reads the whale path out of `apps/web/public/favicon.svg` (byte-identical artwork to
`website/public/favicon.svg`, which renders it in the same brand blue) and never traces, stretches, or
redraws the mark. `sharp` is resolved from `packages/attachment/attachment-local`, the workspace
package that already depends on it, so no new dependency is introduced.

`apps/desktop/electron-builder.config.mjs` embeds `assets/icon.ico` into `DeepSeek Harness.exe`, and
NSIS, the portable stub, the uninstaller, and both shortcuts inherit it from that executable resource —
so an icon change is one regenerated file plus a rebuild, with no separate `.ico` path to maintain.
The unpackaged development shell points a `BrowserWindow` at the same file, because a development
Electron binary carries no embedded resource of its own.

The installer creates both shortcuts without any post-install step:

```jsonc
nsis: { createStartMenuShortcut: true, createDesktopShortcut: true, shortcutName: 'DeepSeek Harness' }
```

`scripts/verify-desktop-shortcut.ps1` locates the installed application through the Windows uninstall
registry (`DisplayIcon`, then `InstallLocation`, then `UninstallString`, then the `Programs`
directories — never a build output), resolves the desktop directory through the Shell special-folder
API, creates the shortcut if needed, verifies every field, and with `-Launch` starts the application
through the shortcut and checks that the backend reaches ready and then exits with it.

## Shell configuration and the owned Harness home

The shell resolves the Harness home it owns **before** it opens the profile or starts the backend,
because `resolveDesktopPaths()` derives the Electron-owned profile and package-manager state from the
same home the backend reads. Deriving that home twice would let the shell and its backend disagree
about which profile they are using, so the shell resolves it once and pins it into the backend's
child environment.

Two shell-owned config locations exist under `%APPDATA%\DeepSeekHarness\`:

| Path | Purpose |
|---|---|
| `desktop-config.json` | Optional. `{ "dshHome": "<absolute path>" }` |
| `logs\desktop.log` | Startup, resolved-home, and backend lifecycle diagnostics |

Precedence, highest first:

1. an absolute `dshHome` in `desktop-config.json`;
2. `DSH_HOME` inherited from the process that launched the application;
3. the Harness default home, `~/.dsh`.

Steps 2 and 3 are the Harness resolution itself — the shell calls `resolveDshHome` from
`@deepseek-ai/dsh-home-paths`, the same helper `apps/desktop/src/paths.ts` and the Harness host use.
The desktop config only adds the ability to outrank the environment, which is what makes the
application independent of whatever launched it. Tilde forms such as `~/harness-home` are expanded by
that same helper.

Startup records the decision, so the active home is never a guess:

```
Resolved DSH_HOME: D:\example\harness-home
Source: desktop-config
```

`Source` is `desktop-config`, `environment`, or `default`.

Failure handling is deliberately non-fatal. A missing file keeps the previous behaviour. A file that
is unreadable, invalid JSON, not a JSON object, or whose `dshHome` is empty, non-string, or relative is
ignored with a `Configuration warning:` line in the log, and resolution continues to the next step. The
application never refuses to start because of its own configuration.

Only `DSH_HOME` is injected into the backend child environment, together with removal of the
`HOME`/`HOMEDRIVE`/`HOMEPATH` overrides. No machine-level or user-level environment variable is read
for writing, and none is written.

## Relationship to the official shell

| Concern | Owner |
|---|---|
| Electron main process, preload, windows, IPC, protocol | `apps/desktop` (unchanged) |
| Backend child-process lifecycle and readiness | `apps/desktop` (unchanged) |
| Bundled Node.js, pnpm, and the production Harness tree | `apps/desktop` (unchanged) |
| Application icon, NSIS installer and shortcut configuration | `apps/desktop` (official config) |
| Icon artwork and generation | `apps/desktop/assets/`, `scripts/build-icons.mjs` |
| Harness-home resolution and the shell log | `apps/desktop/src/desktop-config.ts`, `logger.ts` |
| Extra `portable` target, `dist-desktop/` output, builder cache location | this directory |

`scripts/portable-targets.mjs` imports the official config factory
(`apps/desktop/electron-builder.config.mjs`) and only appends a target, so upgrade, runtime
verification, and signing configuration keep flowing from the official single source of truth.
