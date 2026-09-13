<#
.SYNOPSIS
Verify a packaged DeepSeek Harness desktop build end to end.

.DESCRIPTION
Starts the given executable, waits for the shell log to report a ready backend, asserts that the
bundled runtime Node.js is the backend's parent-owned child, closes the window, and asserts that the
application and its backend exit while every pre-existing Node.js process survives.

The checks mirror what a manual smoke test would do, so a packaged build can be re-verified after any
change without reading process tables by hand.

.PARAMETER Executable
Path to the portable executable or the installed application executable.

.PARAMETER TimeoutSeconds
Seconds to wait for `backend ready` in the shell log.

.PARAMETER LogDirectory
Shell log directory. Defaults to `%APPDATA%\DeepSeekHarness\logs`.

.PARAMETER KeepRunning
Leave the application running instead of closing it and checking teardown.

.EXAMPLE
pwsh -NoProfile -File apps/desktop-portable/scripts/verify-desktop.ps1 `
  -Executable dist-desktop/DeepSeek-Harness-0.1.5-rc.2-portable.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [int]$TimeoutSeconds = 300,
  [string]$LogDirectory = (Join-Path $env:APPDATA 'DeepSeekHarness\logs'),
  [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if ($Condition) { Write-Host "  PASS  $Message" }
  else { Write-Host "  FAIL  $Message" -ForegroundColor Red; $script:failures.Add($Message) }
}

function Get-NodeProcessIds {
  @(Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

Write-Host "DeepSeek Harness desktop verification" -ForegroundColor Cyan
Write-Host "  executable : $Executable"
Write-Host "  log        : $LogDirectory"

if (-not (Test-Path -LiteralPath $Executable)) { throw "Executable not found: $Executable" }
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$installRoot = Split-Path -Parent $executablePath
$logFile = Join-Path $LogDirectory 'desktop.log'

# A previous run's log would satisfy the readiness wait immediately.
if (Test-Path -LiteralPath $LogDirectory) { Remove-Item -LiteralPath $LogDirectory -Recurse -Force }

$nodeBefore = Get-NodeProcessIds
Write-Host "`n[1] starting application" -ForegroundColor Cyan
Start-Process -FilePath $executablePath | Out-Null

Write-Host "`n[2] waiting for backend readiness (timeout ${TimeoutSeconds}s)" -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $logFile) {
    if (Select-String -LiteralPath $logFile -Pattern 'backend ready' -Quiet) { $ready = $true; break }
    if (Select-String -LiteralPath $logFile -Pattern 'backend error' -Quiet) { break }
  }
  Start-Sleep -Seconds 3
}
Assert-True $ready 'shell log reports "backend ready"'

Write-Host "`n[3] shell log" -ForegroundColor Cyan
if (Test-Path -LiteralPath $logFile) { Get-Content -LiteralPath $logFile | ForEach-Object { "        $_" } }

Write-Host "`n[4] packaged runtime is the backend" -ForegroundColor Cyan
$main = Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -eq $executablePath -and $_.CommandLine -notmatch '--type=' } |
  Select-Object -First 1
Assert-True ($null -ne $main) 'main process is running'

$backend = $null
if ($null -ne $main) {
  $backend = Get-CimInstance Win32_Process |
    Where-Object { $_.ParentProcessId -eq $main.ProcessId -and $_.Name -eq 'node.exe' } |
    Select-Object -First 1
}
Assert-True ($null -ne $backend) 'backend Node.js child is running'
if ($null -ne $backend) {
  Assert-True ($backend.ExecutablePath -like '*\resources\runtime\node\node.exe') `
    "backend uses the bundled runtime: $($backend.ExecutablePath)"
  Assert-True ($backend.CommandLine -like '*dsh-desktop-host*') 'backend runs the private desktop host entry'
}

Write-Host "`n[5] window" -ForegroundColor Cyan
$window = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -ne '' -and $_.Path -eq $executablePath } |
  Select-Object -First 1
Assert-True ($null -ne $window) "a window is open: $(if ($window) { $window.MainWindowTitle })"

if ($KeepRunning) {
  Write-Host "`n-KeepRunning set; leaving the application running." -ForegroundColor Yellow
} else {
  Write-Host "`n[6] closing the window and checking teardown" -ForegroundColor Cyan
  $mainProcess = if ($null -ne $main) { Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue } else { $null }
  if ($null -ne $mainProcess) { $null = $mainProcess.CloseMainWindow() }

  $quitDeadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $quitDeadline) {
    $still = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $executablePath }
    if (-not $still) { break }
    Start-Sleep -Seconds 2
  }
  $leftover = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $executablePath }
  Assert-True ($null -eq $leftover) 'application processes exited'

  $backendLeft = Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -like "$installRoot\resources\runtime\node\node.exe" }
  Assert-True ($null -eq $backendLeft) 'backend child exited with the application'

  $nodeAfter = Get-NodeProcessIds
  $lost = @($nodeBefore | Where-Object { $_ -notin $nodeAfter })
  Assert-True ($lost.Count -eq 0) "no pre-existing Node.js process was killed$(if ($lost.Count) { " (lost: $($lost -join ', '))" })"
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host "RESULT: all checks passed" -ForegroundColor Green
  exit 0
}
Write-Host "RESULT: $($failures.Count) check(s) failed" -ForegroundColor Red
foreach ($failure in $failures) { Write-Host "  - $failure" -ForegroundColor Red }
exit 1
