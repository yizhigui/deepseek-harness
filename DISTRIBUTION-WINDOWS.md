# DeepSeek Harness for Windows

Use `DeepSeek-Harness-Setup-0.1.5-rc.2.exe` for a normal installation. The portable executable is an optional alternative and can take longer to start because it extracts its application files before launching.

This Windows x64 build contains its own runtime. Users do not need to install Node.js, Git, pnpm, npm, Python, PowerShell 7, or WSL.

## Install and start

1. Run `DeepSeek-Harness-Setup-0.1.5-rc.2.exe`.
2. Complete the installer and start **DeepSeek Harness** from the desktop shortcut or Start menu.
3. On first launch, add your own DeepSeek API key in the model setup screen.

No API key, settings, or sessions are included in the installer. By default, Harness user data is stored in `%USERPROFILE%\.dsh`. Desktop shell configuration and logs are stored under `%APPDATA%\DeepSeekHarness`. An advanced user can create `%APPDATA%\DeepSeekHarness\desktop-config.json` with an absolute `dshHome` value to select a different Harness home.

## Windows security notice

Unsigned build — Windows SmartScreen may warn users. This build has no publisher signature, so Windows can show **Unknown Publisher** or a SmartScreen prompt. A warning does not by itself mean the download is damaged. Verify the SHA-256 hash from `SHA256SUMS.txt` before running it.

PowerShell can calculate a hash with:

```powershell
Get-FileHash .\DeepSeek-Harness-Setup-0.1.5-rc.2.exe -Algorithm SHA256
```

Compare the complete hash with the matching line in `SHA256SUMS.txt`.

## Uninstall

Open **Settings → Apps → Installed apps**, find **DeepSeek Harness**, and choose **Uninstall**. The uninstaller removes the application. Harness user data is kept separately so an uninstall does not silently remove API configuration or sessions.

## Reproducing this distribution

`apps/desktop-portable/scripts/build-distribution.ps1` runs the supported pipeline end to end. It
sets the required release identity, clears signing configuration for an honestly unsigned artifact,
pins `ELECTRON_BUILDER_CACHE` to the build volume to avoid the cross-volume `EXDEV` rename failure,
and removes `DSH_HOME` so no build step can read the maintainer's Harness home.

```powershell
# Full rebuild: compile, prepare the runtime, and emit both artifacts plus release-windows/.
powershell -NoProfile -File apps/desktop-portable/scripts/build-distribution.ps1

# Reuse an already prepared application tree and only re-emit the two artifacts.
powershell -NoProfile -File apps/desktop-portable/scripts/build-distribution.ps1 -SkipPrepare
```

The pipeline is `package:desktop:win:x64:unsigned` (NSIS into `unsigned-artifacts/`), then
`package-portable.mjs win-x64` (NSIS plus portable into `dist-desktop/`), then
`prepare-distribution.ps1` (the two user-facing executables, the README, and SHA-256 sums into
`release-windows/`).

Verify a finished build with:

| Check | Command |
|---|---|
| No user state, personal path, or secret in the packaged tree | `scripts/audit-distribution.ps1 -Roots <tree> -SecretSourceFiles <local secrets> -ForbiddenPersonalPaths <paths>` |
| First-use onboarding with an isolated home | `scripts/verify-clean-user.ps1 -Executable <packaged exe>` |
| No secret, personal path, or unexpected file in the handoff set | `scripts/verify-release-security.ps1 -Directory release-windows -SecretSourceFiles <local secrets> -ForbiddenPaths <paths> -AllowedNames <expected files>` |

The scripts run on Windows PowerShell 5.1 as well as PowerShell 7; they avoid .NET Core-only
`String.Contains` overloads so the audit stays runnable on a stock Windows host.

Because `verify-clean-user.ps1` isolates the profile through environment variables, an already
running installed Desktop still owns Electron's single-instance lock, and the test process exits
immediately. Either close the installed application first, or launch the packaged executable with
`--user-data-dir <empty directory>` to give the test its own lock and profile.
