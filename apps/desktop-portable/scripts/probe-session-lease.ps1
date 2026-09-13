# Diagnose SessionAlreadyOwnedError by reporting each session's write-lease state.
#
# On Windows a session lease is a NAMED KERNEL SEMAPHORE, not a file:
# `Local\dsh-session-lock-<sha256>`, derived from the resolved, case-folded lock
# path (packages/session/session-persistence-jsonl/src/win32.ts:153). There is no
# `session.lock` on disk to inspect or delete, so a kernel probe is the only way
# to observe ownership.
#
# This script only tests whether the lease can be acquired immediately: it opens
# the semaphore and performs a zero-timeout wait. When that wait succeeds it calls
# ReleaseSemaphore at once, so the lease is returned in the same instant and the
# observable lock state is unchanged.
#
# Purpose: answer "is this session's owner still alive?" for SessionAlreadyOwnedError.
# The probe is read-only and never mutates the home: it does not delete locks, kill
# processes, modify sessions, or touch DSH_HOME. A crashed owner needs no cleanup --
# the kernel drops the lease with the process, so `free` simply means the lock is
# available now.
#
# Usage:
#   pwsh -NoProfile -File probe-session-lease.ps1 -SessionsRoot <path> [-SessionId <id>]
#
# -SessionsRoot is required rather than defaulted so no machine-specific Harness home
# is baked in. -SessionId is an optional substring filter that only narrows the report.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SessionsRoot,
  [string]$SessionId
)

$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class LeaseProbe {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateSemaphoreW(IntPtr sec, int initial, int max, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReleaseSemaphore(IntPtr h, int count, IntPtr prev);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  const uint WAIT_OBJECT_0 = 0;
  const uint WAIT_TIMEOUT = 0x102;
  // Mirrors acquireLockHandleWin32: name from resolve(path).ToLowerInvariant().
  public static string SemaphoreName(string lockPath) {
    string full = System.IO.Path.GetFullPath(lockPath).ToLowerInvariant();
    using (var sha = SHA256.Create()) {
      byte[] d = sha.ComputeHash(Encoding.UTF8.GetBytes(full));
      var sb = new StringBuilder("Local\\dsh-session-lock-");
      foreach (byte b in d) sb.Append(b.ToString("x2"));
      return sb.ToString();
    }
  }
  // Returns "free", "held", or "error:<code>".
  public static string Probe(string lockPath) {
    string name = SemaphoreName(lockPath);
    IntPtr h = CreateSemaphoreW(IntPtr.Zero, 1, 1, name);
    if (h == IntPtr.Zero) return "error:" + Marshal.GetLastWin32Error();
    try {
      uint w = WaitForSingleObject(h, 0);
      if (w == WAIT_OBJECT_0) { ReleaseSemaphore(h, 1, IntPtr.Zero); return "free"; }
      if (w == WAIT_TIMEOUT) return "held";
      return "error:" + Marshal.GetLastWin32Error();
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$sessions = Get-ChildItem $SessionsRoot -Directory -ErrorAction SilentlyContinue
if (-not $sessions) { throw "no project directories under $SessionsRoot" }

$rows = @()
foreach ($project in $sessions) {
  $sessionDirs = Get-ChildItem $project.FullName -Directory -ErrorAction SilentlyContinue
  foreach ($dir in $sessionDirs) {
    if ($SessionId -and $dir.Name -notlike "*$SessionId*") { continue }
    $lockPath = Join-Path $dir.FullName 'session.lock'
    $state = [LeaseProbe]::Probe($lockPath)
    $log = Get-ChildItem $dir.FullName -File -ErrorAction SilentlyContinue | Select-Object -First 1
    $rows += [pscustomobject]@{
      Session   = $dir.Name
      Lease     = $state
      LogMtime  = if ($log) { $log.LastWriteTime.ToString('MM-dd HH:mm:ss') } else { '-' }
      LogBytes  = if ($log) { $log.Length } else { 0 }
    }
  }
}

$held = @($rows | Where-Object { $_.Lease -eq 'held' })
$free = @($rows | Where-Object { $_.Lease -eq 'free' })
$err  = @($rows | Where-Object { $_.Lease -like 'error*' })

$rows | Sort-Object Session | Format-Table -AutoSize
Write-Host ""
Write-Host ("sessions probed : {0}" -f $rows.Count)
Write-Host ("  HELD (someone owns) : {0}" -f $held.Count) -ForegroundColor Yellow
Write-Host ("  free                : {0}" -f $free.Count) -ForegroundColor Green
Write-Host ("  error               : {0}" -f $err.Count) -ForegroundColor Red
if ($held.Count -gt 0) {
  Write-Host ""
  Write-Host "Held sessions:" -ForegroundColor Yellow
  $held | ForEach-Object { Write-Host ("  {0}   log mtime {1}" -f $_.Session, $_.LogMtime) }
}
Write-Host ""
Write-Host "Reminder: 'free' means no live handle holds the lease. Nothing was deleted or released by this probe"
Write-Host "beyond what it took and immediately returned."
