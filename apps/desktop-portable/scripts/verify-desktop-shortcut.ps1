<#
.SYNOPSIS
Create or verify the "DeepSeek Harness" desktop shortcut for the installed application.

.DESCRIPTION
Finds the NSIS-installed DeepSeek Harness by asking Windows where it was registered, rather than
assuming an install path. Candidates are preferred in this order:

1. an entry under `HKCU:\...\Uninstall` whose `InstallLocation` holds `DeepSeek Harness.exe` and whose
   uninstaller exists (the authoritative record that NSIS created);
2. the same lookup under `HKLM`;
3. conventional per-user and per-machine `Programs` directories.

Build outputs are never used: `dist-desktop`, `win-unpacked`, portable executables, and repository
sources are excluded by construction, because only a registered install or a `Programs` directory is
ever probed.

The desktop directory comes from the Windows Shell special-folder API, so OneDrive redirection,
enterprise policy, localized folder names, and custom profiles all resolve correctly.

The shortcut targets the installed executable with its own directory as the working directory, and
takes its icon from the executable itself, so future icon updates need no separate `.ico` path.

.PARAMETER VerifyOnly
Read and report the existing shortcut without creating or repairing it.

.PARAMETER Launch
Start the shortcut and confirm the application comes up, then close it and confirm the backend exits.

.EXAMPLE
pwsh -NoProfile -File apps/desktop-portable/scripts/verify-desktop-shortcut.ps1

.EXAMPLE
pwsh -NoProfile -File apps/desktop-portable/scripts/verify-desktop-shortcut.ps1 -Launch
#>
[CmdletBinding()]
param(
  [switch]$VerifyOnly,
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if ($Condition) { Write-Host "  PASS  $Message" }
  else { Write-Host "  FAIL  $Message" -ForegroundColor Red; $script:failures.Add($Message) }
}

$executableName = 'DeepSeek Harness.exe'
$shortcutName = 'DeepSeek Harness'

# ── Locate the installed application ─────────────────────────────────────────────────────────────
function Remove-Quoting {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  # Registry values may arrive quoted, e.g. DisplayIcon or the executable half of UninstallString.
  return $Value.Trim().Trim('"').Trim()
}

function Test-InstallDirectory {
  param([string]$Directory)
  if ([string]::IsNullOrWhiteSpace($Directory)) { return $null }
  $exe = Join-Path $Directory $executableName
  if (-not (Test-Path -LiteralPath $exe)) { return $null }
  # A registered install must still own its uninstaller.
  if (-not (Test-Path -LiteralPath (Join-Path $Directory "Uninstall $shortcutName.exe"))) { return $null }
  return $exe
}

function Get-InstalledApplication {
  $uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $uninstallRoots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $entry = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $entry) { continue }
      if ($entry.DisplayName -notlike "*$shortcutName*") { continue }

      # DisplayIcon is written as "<exe>,0"; it is the most reliable pointer to the install.
      $iconPath = (Remove-Quoting $entry.DisplayIcon) -replace ',\s*-?\d+$', ''
      if (-not [string]::IsNullOrWhiteSpace($iconPath)) {
        $directory = Split-Path -Parent $iconPath
        $exe = Test-InstallDirectory $directory
        if ($null -ne $exe) { return [pscustomobject]@{ Path = $exe; Source = "registry-displayicon:$($key.PSChildName)"; Location = $directory } }
      }

      # Fall back to InstallLocation, which some installers leave empty.
      $location = Remove-Quoting $entry.InstallLocation
      $exe = Test-InstallDirectory $location
      if ($null -ne $exe) { return [pscustomobject]@{ Path = $exe; Source = "registry-installlocation:$($key.PSChildName)"; Location = $location } }

      # Last registry resort: the executable half of UninstallString.
      $uninstall = Remove-Quoting ($entry.UninstallString -replace '\s+/.*$', '')
      if (-not [string]::IsNullOrWhiteSpace($uninstall)) {
        $directory = Split-Path -Parent $uninstall
        $exe = Test-InstallDirectory $directory
        if ($null -ne $exe) { return [pscustomobject]@{ Path = $exe; Source = "registry-uninstallstring:$($key.PSChildName)"; Location = $directory } }
      }
    }
  }
  $programRoots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    (Join-Path $env:ProgramFiles 'Programs'),
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  foreach ($root in $programRoots) {
    $directory = Join-Path $root $shortcutName
    $exe = Test-InstallDirectory $directory
    if ($null -ne $exe) { return [pscustomobject]@{ Path = $exe; Source = "programs:$root"; Location = $directory } }
  }
  return $null
}

Write-Host 'DeepSeek Harness desktop shortcut' -ForegroundColor Cyan

$application = Get-InstalledApplication
if ($null -eq $application) {
  Write-Host '  No installed DeepSeek Harness found (no registered uninstall entry, no Programs directory).' -ForegroundColor Yellow
  Write-Host '  Install the new dist-desktop\DeepSeek-Harness-Setup-*.exe first; a shortcut is not created for a missing target.' -ForegroundColor Yellow
  exit 2
}
Write-Host "  installed  : $($application.Path)"
Write-Host "  discovered : $($application.Source)"

# ── Resolve the real desktop directory through the Shell ─────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
  $desktop = [System.Windows.Forms.Environment]::GetFolderPath('Desktop')
}
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
  throw 'could not resolve the Windows desktop directory through the Shell special-folder API'
}
Write-Host "  desktop    : $desktop"

$linkPath = Join-Path $desktop "$shortcutName.lnk"

# ── Create or repair ─────────────────────────────────────────────────────────────────────────────
if (-not $VerifyOnly) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($linkPath)
  $shortcut.TargetPath = $application.Path
  $shortcut.WorkingDirectory = Split-Path -Parent $application.Path
  $shortcut.Description = $shortcutName
  # Icon comes from the installed executable itself, so moving the repository cannot break it.
  $shortcut.IconLocation = "$($application.Path),0"
  $shortcut.Arguments = ''
  $shortcut.WindowStyle = 1
  $shortcut.Save()
  Write-Host "  created    : $linkPath"
}

# ── Verify ───────────────────────────────────────────────────────────────────────────────────────
Write-Host "`nVerification" -ForegroundColor Cyan
Assert-True (Test-Path -LiteralPath $linkPath) 'shortcut file exists'
if (-not (Test-Path -LiteralPath $linkPath)) {
  Write-Host "`nRESULT: cannot verify a missing shortcut" -ForegroundColor Red
  exit 1
}
Assert-True ((Split-Path -Leaf $linkPath) -eq "$shortcutName.lnk") "shortcut is named $shortcutName.lnk"

$shell = New-Object -ComObject WScript.Shell
$read = $shell.CreateShortcut($linkPath)
$target = $read.TargetPath
$working = $read.WorkingDirectory
$icon = $read.IconLocation
$arguments = $read.Arguments

Assert-True (Test-Path -LiteralPath $target) "target exists: $target"
Assert-True ($target -ieq $application.Path) 'target is the installed DeepSeek Harness.exe'
Assert-True ((Split-Path -Leaf $target) -ieq $executableName) 'target file name is exactly the application executable'
Assert-True ($working -ieq (Split-Path -Parent $target)) 'working directory is the executable directory'
Assert-True ($icon -ilike "$target,*") 'icon resolves to the installed executable'
Assert-True ([string]::IsNullOrWhiteSpace($arguments)) 'no arguments attached'
foreach ($forbidden in @('--inspect', '--remote-debugging-port', 'node.exe', 'pnpm', 'pwsh', 'powershell', '.ps1', '.cmd', 'win-unpacked', 'dist-desktop')) {
  Assert-True ($target -inotlike "*$forbidden*") "target does not reference $forbidden"
  Assert-True ($arguments -inotlike "*$forbidden*") "arguments do not reference $forbidden"
}

Write-Host "`nDesktop shortcut:"; Write-Host $linkPath
Write-Host "`nTarget:"; Write-Host $target
Write-Host "`nWorking directory:"; Write-Host $working
Write-Host "`nIcon:"; Write-Host $icon

# ── Optional launch check ────────────────────────────────────────────────────────────────────────
if ($Launch) {
  Write-Host "`nLaunch verification" -ForegroundColor Cyan
  $nodeBefore = @(Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $logFile = Join-Path (Join-Path $env:APPDATA 'DeepSeekHarness') 'logs\desktop.log'
  if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile -Force }

  Start-Process -FilePath $linkPath | Out-Null
  $deadline = (Get-Date).AddSeconds(240)
  $ready = $false
  $window = $null
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $logFile) {
      if (Select-String -LiteralPath $logFile -Pattern 'backend ready' -Quiet) { $ready = $true }
    }
    $window = Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -eq $shortcutName -and $_.Path -eq $target } | Select-Object -First 1
    if ($ready -and $null -ne $window) { break }
    Start-Sleep -Seconds 3
  }
  Assert-True $ready 'backend reached ready through the shortcut launch'
  Assert-True ($null -ne $window) "window title became $shortcutName"

  if (Test-Path -LiteralPath $logFile) { Get-Content -LiteralPath $logFile | ForEach-Object { "        $_" } }

  $main = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1
  if ($null -ne $main) { $null = (Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue).CloseMainWindow() }
  $quitDeadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $quitDeadline) {
    if (-not (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target })) { break }
    Start-Sleep -Seconds 2
  }
  $left = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target }
  Assert-True ($null -eq $left) 'application exited'
  $backend = Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -like (Join-Path (Split-Path -Parent $target) 'resources\runtime\node\node.exe') }
  Assert-True ($null -eq $backend) 'backend child exited with the application'

  $nodeAfter = @(Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $lost = @($nodeBefore | Where-Object { $_ -notin $nodeAfter })
  Assert-True ($lost.Count -eq 0) "no pre-existing Node.js process was killed$(if ($lost.Count) { " (lost: $($lost -join ', '))" })"
  $web = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue
  Assert-True ($null -ne $web) 'the Web session on port 3080 is still listening'
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host 'RESULT: all checks passed' -ForegroundColor Green
  exit 0
}
Write-Host "RESULT: $($failures.Count) check(s) failed" -ForegroundColor Red
foreach ($failure in $failures) { Write-Host "  - $failure" -ForegroundColor Red }
exit 1
