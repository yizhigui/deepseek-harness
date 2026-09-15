<#
.SYNOPSIS
Build the user-facing Windows x64 distribution from the official desktop packaging pipeline.

.DESCRIPTION
Orchestrates the three supported steps and never reimplements them:

1. `pnpm run package:desktop:win:x64:unsigned` compiles the repository, prepares the bundled
   Node.js/runtime/dsh trees, and produces the unsigned NSIS installer into
   `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts`.
2. `scripts/package-portable.mjs win-x64` repacks that verified application tree with the add-on
   configuration to emit both the NSIS installer and the portable executable into `dist-desktop/`.
3. `scripts/prepare-distribution.ps1` copies only the two user-facing executables and the recipient
   README into the ignored `release-windows/` directory and writes `SHA256SUMS.txt`.

The packaging environment is hermetic in the sense that matters for a recipient: `DSH_HOME` is
removed so no build step can read the maintainer's Harness home, `CSC_IDENTITY_AUTO_DISCOVERY` and
the Windows signing variables are cleared so the artifact is honestly unsigned, and
`ELECTRON_BUILDER_CACHE` is pinned to the build volume to avoid the cross-volume `EXDEV` rename
failure that electron-builder hits when its cache lives on `C:` and the scratch directory on `D:`.

.PARAMETER NodeRoot
Directory holding the Node.js toolchain used to run the build.

.PARAMETER PnpmBin
Directory holding the `pnpm` shim used to run the build.

.PARAMETER SkipPrepare
Reuse the already prepared application tree and only re-emit the two artifacts.

.PARAMETER SkipPackage
Stop after preparing the application tree; do not run electron-builder.

.EXAMPLE
pwsh -NoProfile -File scripts/build-distribution.ps1
#>
[CmdletBinding()]
param(
  [string]$NodeRoot = 'D:\AI\DeepSeek-Harness-tools\node-v24.19.0-win-x64',
  [string]$PnpmBin = 'D:\AI\DeepSeek-Harness-tools\package-manager\node_modules\.bin',
  [string]$AppId = 'ai.deepseek.harness',
  [switch]$SkipPrepare,
  [switch]$SkipPackage
)

# Only this script's own failures are terminating. Native tools (pnpm, electron-builder) write
# progress to stderr, and under `Stop` Windows PowerShell 5.1 promotes each such line to a
# terminating NativeCommandError, which would abort a healthy build.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$desktopRoot = Join-Path $repository 'apps\desktop'
$targetRoot = Join-Path $desktopRoot '.desktop-build\targets\win-x64'

if (-not (Test-Path -LiteralPath (Join-Path $NodeRoot 'node.exe'))) {
  throw "Node.js toolchain not found: $NodeRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $PnpmBin 'pnpm.cmd'))) {
  throw "pnpm shim not found: $PnpmBin"
}

# Keep the toolchain first so the build never silently picks up another Node.js installation.
$env:Path = "$NodeRoot;$PnpmBin;$env:Path"

# The release identity is required by the official electron-builder configuration and is never defaulted there.
$env:DSH_DESKTOP_APP_ID = $AppId
# An unsigned local artifact: no certificate discovery, no token signing.
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
# Same-volume tool cache, otherwise electron-builder fails renaming across C: and D:.
$env:ELECTRON_BUILDER_CACHE = Join-Path $desktopRoot '.desktop-build\downloads\electron-builder-cache'

# A recipient's build must never read the maintainer's Harness home, credentials, or sessions.
Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue

Write-Host "build-distribution: node $( & (Join-Path $NodeRoot 'node.exe') --version )"
Write-Host "build-distribution: app id $env:DSH_DESKTOP_APP_ID"
Write-Host "build-distribution: electron-builder cache $env:ELECTRON_BUILDER_CACHE"

if (-not $SkipPrepare) {
  Write-Host 'build-distribution: [1/3] official unsigned win-x64 package'
  & pnpm run package:desktop:win:x64:unsigned
  if ($LASTEXITCODE -ne 0) { throw "package:desktop:win:x64:unsigned exited with $LASTEXITCODE" }
}
$application = Join-Path $targetRoot 'unsigned-artifacts\win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $application 'DeepSeek Harness.exe'))) {
  throw "No prepared application at $application; run without -SkipPrepare"
}

if (-not $SkipPackage) {
  Write-Host 'build-distribution: [2/3] installer + portable artifacts'
  & pnpm --dir apps/desktop-portable exec node scripts/package-portable.mjs win-x64
  if ($LASTEXITCODE -ne 0) { throw "package-portable.mjs exited with $LASTEXITCODE" }
}

Write-Host 'build-distribution: [3/3] assemble release-windows'
& (Join-Path $PSScriptRoot 'prepare-distribution.ps1')
if ($LASTEXITCODE -ne 0) { throw "prepare-distribution.ps1 exited with $LASTEXITCODE" }

Write-Host 'build-distribution: done'
