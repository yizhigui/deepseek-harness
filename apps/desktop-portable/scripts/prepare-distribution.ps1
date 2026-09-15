<#
.SYNOPSIS
Create the small, user-facing Windows distribution directory from verified desktop artifacts.

.DESCRIPTION
Copies only the installer, portable executable, and user documentation. It then writes SHA256SUMS.txt.
The output directory is ignored by Git and must never be committed.
#>
[CmdletBinding()]
param(
  [string]$Version = '0.1.5-rc.2',
  [string]$ArtifactDirectory = (Join-Path $PSScriptRoot '..\..\..\dist-desktop'),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\..\release-windows')
)

$ErrorActionPreference = 'Stop'
$artifactDirectoryPath = [IO.Path]::GetFullPath($ArtifactDirectory)
$outputDirectoryPath = [IO.Path]::GetFullPath($OutputDirectory)
$files = @(
  "DeepSeek-Harness-Setup-$Version.exe",
  "DeepSeek-Harness-$Version-portable.exe"
)

foreach ($name in $files) {
  $source = Join-Path $artifactDirectoryPath $name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing distribution artifact: $source" }
}

if (Test-Path -LiteralPath $outputDirectoryPath) {
  $resolved = (Resolve-Path -LiteralPath $outputDirectoryPath).Path
  $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
  if (-not $resolved.StartsWith($repository, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace an output directory outside the repository: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
New-Item -ItemType Directory -Path $outputDirectoryPath | Out-Null

foreach ($name in $files) {
  Copy-Item -LiteralPath (Join-Path $artifactDirectoryPath $name) -Destination (Join-Path $outputDirectoryPath $name)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\README.distribution.txt') -Destination (Join-Path $outputDirectoryPath 'README.txt')

$sumLines = foreach ($name in $files) {
  $hash = Get-FileHash -LiteralPath (Join-Path $outputDirectoryPath $name) -Algorithm SHA256
  "$($hash.Hash.ToLowerInvariant())  $name"
}
[IO.File]::WriteAllLines((Join-Path $outputDirectoryPath 'SHA256SUMS.txt'), $sumLines, [Text.UTF8Encoding]::new($false))

Write-Host "Windows distribution created at $outputDirectoryPath"
foreach ($name in $files) {
  $item = Get-Item -LiteralPath (Join-Path $outputDirectoryPath $name)
  $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
  Write-Host "  $name | $($item.Length) bytes | SHA-256 $hash"
}
