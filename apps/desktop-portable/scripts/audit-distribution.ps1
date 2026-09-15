<#
.SYNOPSIS
Scan a packaged Windows application tree for user state, personal paths, and credential values.

.DESCRIPTION
Reports only the file path, finding type, and whether the finding blocks distribution. Secret values
are never printed. Exact secret candidates may be loaded from local credential and environment files
for comparison, but those source files are never copied or included in the scan roots.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Roots,
  [string[]]$SecretSourceFiles = @(),
  [string[]]$ForbiddenPersonalPaths = @()
)

$ErrorActionPreference = 'Stop'
$findings = [Collections.Generic.List[object]]::new()
$secretValues = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)

function Add-Finding([string]$Path, [string]$Type, [bool]$Blocks) {
  $findings.Add([pscustomobject]@{ Path = $Path; Type = $Type; Blocks = $Blocks })
}

<#
Report whether one decoded text contains a needle.
`String.Contains(string, StringComparison)` only exists on .NET Core and later, so this uses the
`IndexOf` overload that .NET Framework 4.x and PowerShell 5.1 also provide. Keeping the comparison
ordinal preserves the exact-match semantics this audit relies on.
#>
function Test-ContainsText([string]$Text, [string]$Needle, [bool]$IgnoreCase) {
  $comparison = if ($IgnoreCase) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  return $Text.IndexOf($Needle, $comparison) -ge 0
}

foreach ($source in $SecretSourceFiles) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
  foreach ($line in [IO.File]::ReadLines((Resolve-Path -LiteralPath $source).Path)) {
    $candidate = if ($line -match '^\s*[^#]*?(?:secret|token|password|api[_-]?key|auth)[^:]*:\s*(.+?)\s*$') {
      $Matches[1]
    } elseif ($line -match '^\s*[^#=]*?(?:secret|token|password|api[_-]?key|auth)[^=]*=(.+?)\s*$') {
      $Matches[1]
    } else { $null }
    if ($null -eq $candidate) { continue }
    $candidate = $candidate.Trim().Trim('"').Trim("'")
    if ($candidate.Length -ge 16 -and $candidate -notmatch '^\$\{[^}]+\}$') { $null = $secretValues.Add($candidate) }
  }
}

$sensitiveEnvironmentNames = 'TOKEN|SECRET|PASSWORD|API_KEY|AUTH'
foreach ($entry in Get-ChildItem Env:) {
  if ($entry.Name -notmatch $sensitiveEnvironmentNames -or $entry.Value.Length -lt 16) { continue }
  $null = $secretValues.Add($entry.Value)
}

$resolvedRoots = foreach ($root in $Roots) {
  if (-not (Test-Path -LiteralPath $root)) { throw "Scan root does not exist: $root" }
  (Resolve-Path -LiteralPath $root).Path
}

$asarCli = Get-ChildItem (Join-Path $PSScriptRoot '..\..\..\node_modules\.pnpm') -Directory -Filter '@electron+asar@*' |
  Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'node_modules\@electron\asar\bin\asar.js' }
$temporaryRoots = [Collections.Generic.List[string]]::new()
try {
  $scanRoots = [Collections.Generic.List[string]]::new()
  foreach ($root in $resolvedRoots) { $scanRoots.Add($root) }
  foreach ($asar in $resolvedRoots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -File -Filter app.asar -ErrorAction SilentlyContinue }) {
    if ($null -eq $asarCli -or -not (Test-Path -LiteralPath $asarCli)) { throw 'Could not locate the installed @electron/asar CLI' }
    $extract = Join-Path ([IO.Path]::GetTempPath()) ("dsh-distribution-asar-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $extract | Out-Null
    $temporaryRoots.Add($extract)
    & node $asarCli extract $asar.FullName $extract
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $($asar.FullName)" }
    $scanRoots.Add($extract)
  }

  $forbiddenNames = @('.credentials.yaml', 'desktop-config.json', '.npmrc', '.env')
  foreach ($root in $scanRoots) {
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue) {
      if ($file.Name -in $forbiddenNames) { Add-Finding $file.FullName "forbidden state file: $($file.Name)" $true }
      $bytes = [IO.File]::ReadAllBytes($file.FullName)
      if ($bytes.Length -eq 0) { continue }
      $ascii = [Text.Encoding]::UTF8.GetString($bytes)
      $unicode = [Text.Encoding]::Unicode.GetString($bytes)
      foreach ($path in $ForbiddenPersonalPaths) {
        if ($path -and ((Test-ContainsText $ascii $path $true) -or (Test-ContainsText $unicode $path $true))) {
          Add-Finding $file.FullName 'personal path' $true
        }
      }
      foreach ($secret in $secretValues) {
        if ((Test-ContainsText $ascii $secret $false) -or (Test-ContainsText $unicode $secret $false)) {
          Add-Finding $file.FullName 'exact local secret value' $true
        }
      }
      if ($ascii -match '(?i)(?:npm_[A-Za-z0-9]{20,}|gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})') {
        Add-Finding $file.FullName 'credential-like value' $true
      }
      if ($ascii -match '(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{32,}') {
        Add-Finding $file.FullName 'Bearer-like value for review' $false
      }
    }
  }
} finally {
  foreach ($temporary in $temporaryRoots) {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
}

$unique = $findings | Sort-Object Path,Type,Blocks -Unique
if ($unique) {
  foreach ($finding in $unique) {
    Write-Host "$(if ($finding.Blocks) { 'BLOCK' } else { 'REVIEW' }) | $($finding.Type) | $($finding.Path)"
  }
} else {
  Write-Host 'No sensitive distribution findings.'
}
if ($unique | Where-Object Blocks) { exit 1 }
