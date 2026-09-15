<#
.SYNOPSIS
Launch a packaged Desktop executable with an empty Harness home and verify lifecycle isolation.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("dsh-clean-user-" + [guid]::NewGuid().ToString('N'))
$testHome = Join-Path $testRoot '.dsh'
$testAppData = Join-Path $testRoot 'AppData\Roaming'
$testLocalAppData = Join-Path $testRoot 'AppData\Local'
$logDirectory = Join-Path $testAppData 'DeepSeekHarness\logs'
New-Item -ItemType Directory -Path $testAppData,$testLocalAppData | Out-Null

foreach ($relative in @('.credentials.yaml', 'settings.yaml', '.sessions', 'desktop-config.json')) {
  if (Test-Path -LiteralPath (Join-Path $testHome $relative)) { throw "Clean test home unexpectedly contains $relative" }
}

$original = @{
  DSH_HOME = $env:DSH_HOME
  APPDATA = $env:APPDATA
  LOCALAPPDATA = $env:LOCALAPPDATA
  PATH = $env:PATH
}
$developmentNode = (Get-Command node -ErrorAction Stop).Source
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$debugPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$main = $null
try {
  $env:DSH_HOME = $testHome
  $env:APPDATA = $testAppData
  $env:LOCALAPPDATA = $testLocalAppData
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  $nodeBefore = @(Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  Start-Process -FilePath $executablePath -ArgumentList "--remote-debugging-port=$debugPort" | Out-Null

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $logFile = Join-Path $logDirectory 'desktop.log'
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $logFile) {
      if (Select-String -LiteralPath $logFile -SimpleMatch 'backend ready' -Quiet) { break }
      if (Select-String -LiteralPath $logFile -SimpleMatch 'backend error' -Quiet) { throw 'Packaged backend reported an error' }
    }
    Start-Sleep -Seconds 2
  }
  if (-not (Test-Path -LiteralPath $logFile) -or -not (Select-String -LiteralPath $logFile -SimpleMatch 'backend ready' -Quiet)) {
    throw 'Packaged backend did not reach ready before the timeout'
  }

  $main = Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -eq $executablePath -and $_.CommandLine -notmatch '--type=' } |
    Select-Object -First 1
  if ($null -eq $main) { throw 'Packaged main process is not running' }
  $backend = Get-CimInstance Win32_Process |
    Where-Object { $_.ParentProcessId -eq $main.ProcessId -and $_.Name -eq 'node.exe' } |
    Select-Object -First 1
  if ($null -eq $backend) { throw 'Packaged backend Node.js child is not running' }
  if ($backend.ExecutablePath -notlike '*\resources\runtime\node\node.exe') { throw 'Backend did not use the bundled Node.js runtime' }
  if ($backend.CommandLine -notlike '*dsh-desktop-host*') { throw 'Backend did not run the private desktop host entry' }

  & $developmentNode (Join-Path $PSScriptRoot 'inspect-desktop-ui.mjs') $debugPort
  if ($LASTEXITCODE -ne 0) { throw 'First-use UI verification failed' }

  if (-not (Select-String -LiteralPath $logFile -SimpleMatch "Resolved DSH_HOME: $testHome" -Quiet)) {
    throw 'Desktop did not resolve the isolated Harness home'
  }
  if (Select-String -LiteralPath $logFile -Pattern 'D:\\AI\\DeepSeek-Harness-data|\\Users\\[^\\]+\\\.dsh' -Quiet) {
    throw 'Desktop log referenced a non-test Harness home'
  }
  foreach ($relative in @('.credentials.yaml', 'settings.yaml')) {
    if (Test-Path -LiteralPath (Join-Path $testHome $relative)) { throw "Clean launch unexpectedly created $relative" }
  }
  $mainProcess = Get-Process -Id $main.ProcessId -ErrorAction SilentlyContinue
  if ($null -ne $mainProcess) { $null = $mainProcess.CloseMainWindow() }
  $quitDeadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $quitDeadline) {
    if (-not (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $executablePath })) { break }
    Start-Sleep -Seconds 2
  }
  if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $executablePath }) {
    throw 'Packaged application did not exit after its window closed'
  }
  if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\resources\runtime\node\node.exe' -and $_.ParentProcessId -eq $main.ProcessId }) {
    throw 'Packaged backend remained after the application closed'
  }
  $nodeAfter = @(Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if (@($nodeBefore | Where-Object { $_ -notin $nodeAfter }).Count -ne 0) { throw 'A pre-existing Node.js process was terminated' }
  Write-Host 'RESULT: clean-user home, onboarding UI, bundled backend, ready state, and teardown checks passed' -ForegroundColor Green
} finally {
  if ($null -ne $main) {
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $executablePath } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  foreach ($name in $original.Keys) {
    if ($null -eq $original[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$name" $original[$name] }
  }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
