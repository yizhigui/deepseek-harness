<#
.SYNOPSIS
Final byte-level security scan of the distribution directory.

.DESCRIPTION
Marks the scan complete only when the directory contains exactly the intended files and no file
carries a personal path, a known local secret value, or a credential-shaped token. Secret values
are read from local sources for comparison and are never printed.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Directory,
  [string[]]$SecretSourceFiles = @(),
  [string[]]$ForbiddenPaths = @(),
  [string[]]$AllowedNames = @()
)

$ErrorActionPreference = 'Stop'

function Test-ContainsBytes([byte[]]$Haystack, [byte[]]$Needle) {
  if ($null -eq $Needle -or $Needle.Length -eq 0) { return $false }
  if ($Haystack.Length -lt $Needle.Length) { return $false }
  $last = $Haystack.Length - $Needle.Length
  $first = $Needle[0]
  for ($i = 0; $i -le $last; $i++) {
    if ($Haystack[$i] -ne $first) { continue }
    $matched = $true
    for ($j = 1; $j -lt $Needle.Length; $j++) {
      if ($Haystack[$i + $j] -ne $Needle[$j]) { $matched = $false; break }
    }
    if ($matched) { return $true }
  }
  return $false
}

# Collect exact local secret values for comparison. Values are never echoed.
$secrets = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($source in $SecretSourceFiles) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { Write-Host "note: secret source missing (skipped): $source"; continue }
  foreach ($line in [IO.File]::ReadLines((Resolve-Path -LiteralPath $source).Path)) {
    $candidate = $null
    if ($line -match '^\s*[^#]*?(?:secret|token|password|api[_-]?key|auth)[^:]*:\s*(.+?)\s*$') { $candidate = $Matches[1] }
    elseif ($line -match '^\s*[^#=]*?(?:secret|token|password|api[_-]?key|auth)[^=]*=(.+?)\s*$') { $candidate = $Matches[1] }
    if ($null -eq $candidate) { continue }
    $candidate = $candidate.Trim().Trim('"').Trim("'")
    if ($candidate.Length -ge 16 -and $candidate -notmatch '^\$\{[^}]+\}$') { $null = $secrets.Add($candidate) }
  }
}

$files = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Force)
$failures = [Collections.Generic.List[string]]::new()

Write-Host "final scan root: $Directory"
Write-Host "files present: $($files.Count)"
foreach ($file in $files) {
  $relative = $file.FullName.Substring((Resolve-Path -LiteralPath $Directory).Path.Length).TrimStart('\')
  Write-Host ("  {0} ({1} bytes)" -f $relative, $file.Length)
  if ($AllowedNames.Count -gt 0 -and $relative -notin $AllowedNames) { $failures.Add("unexpected file in distribution: $relative") }
}

$needles = [Collections.Generic.List[object]]::new()
foreach ($path in $ForbiddenPaths) {
  $needles.Add([pscustomobject]@{ Label = "personal path: $path"; Utf8 = [Text.Encoding]::UTF8.GetBytes($path); Utf16 = [Text.Encoding]::Unicode.GetBytes($path) })
}
foreach ($secret in $secrets) {
  $needles.Add([pscustomobject]@{ Label = 'exact local secret value'; Utf8 = [Text.Encoding]::UTF8.GetBytes($secret); Utf16 = [Text.Encoding]::Unicode.GetBytes($secret) })
}

foreach ($file in $files) {
  $bytes = [IO.File]::ReadAllBytes($file.FullName)
  if ($bytes.Length -eq 0) { continue }
  foreach ($needle in $needles) {
    if ((Test-ContainsBytes $bytes $needle.Utf8) -or (Test-ContainsBytes $bytes $needle.Utf16)) {
      $failures.Add("$($file.Name): $($needle.Label)")
    }
  }
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  foreach ($pattern in @(
    '(?i)npm_[A-Za-z0-9]{20,}',
    '(?i)gh[opsu]_[A-Za-z0-9_]{20,}',
    '(?i)github_pat_[A-Za-z0-9_]{20,}',
    '(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{32,}'
  )) {
    if ($text -match $pattern) { $failures.Add("$($file.Name): credential-shaped value matching $pattern") }
  }
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host "PASS: local secret values compared: $($secrets.Count)"
  Write-Host 'PASS: no personal path, no local secret, no credential-shaped token, no unexpected file.'
  exit 0
}
Write-Host "FAIL: $($failures.Count) problem(s)"
foreach ($failure in $failures) { Write-Host "  - $failure" }
exit 2
