# Apply an "app delta" update — extracts an app-vX.zip over the install dir,
# preserving node_modules, the bundled node runtime, nssm, the database, the
# .env file, and the logs directory. Used by the in-app auto-updater when the
# new release's lock_hash matches the installed lock_hash (i.e. dependencies
# haven't changed since the last full install). Saves ~95MB per update vs.
# re-running the full EXE installer.
#
# Called by triggerWindowsUpdate() in src/routes/system.js — runs detached
# in PowerShell. The Node service is still running when this script starts;
# it stops it, swaps the files, restarts it.
#
# On any failure the script restores the previous version from .backup-<ts>
# before re-starting the service, so a partial extract or a service that
# fails to come up never leaves the install in a broken state.

param(
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [Parameter(Mandatory=$false)][string]$ExpectedSha256,
  [Parameter(Mandatory=$false)][string]$AppDir = "C:\Cardoso Customer App",
  [Parameter(Mandatory=$false)][string]$ServiceName = "CardosoCigarettes",
  [Parameter(Mandatory=$false)][string]$NewLockHash = "",
  [Parameter(Mandatory=$false)][string]$NewVersion = ""
)

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $AppDir "logs"
$logFile = Join-Path $logDir "update.log"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

function Log($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  try { Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue } catch {}
  Write-Host $line
}

$backupDir = $null
$stagingDir = $null

try {
  Log "=== Delta update starting ==="
  Log "ZipPath: $ZipPath"
  Log "AppDir: $AppDir"

  if (-not (Test-Path $ZipPath)) {
    throw "Zip not found: $ZipPath"
  }

  # Verify checksum BEFORE touching anything
  if ($ExpectedSha256) {
    $actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $ExpectedSha256.ToLower()) {
      throw "SHA-256 mismatch: expected $ExpectedSha256, got $actual"
    }
    Log "Checksum verified."
  }

  # Stop service. Tolerate "service not installed" / "already stopped".
  Log "Stopping service $ServiceName..."
  $nssm = Join-Path $AppDir "nssm\nssm.exe"
  if (Test-Path $nssm) {
    & $nssm stop $ServiceName 2>&1 | Out-Null
  } else {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3

  # Extract zip to a staging directory adjacent to the install
  $ts = [DateTimeOffset]::Now.ToUnixTimeSeconds()
  $stagingDir = Join-Path $AppDir ".staging-$ts"
  $backupDir  = Join-Path $AppDir ".backup-$ts"
  Log "Extracting to staging: $stagingDir"
  Expand-Archive -Path $ZipPath -DestinationPath $stagingDir -Force

  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

  # Move every top-level item from staging into the install dir, backing up
  # the existing version first. We only touch what's in the zip — node_modules,
  # node/, nssm/, database/, .env, logs/, uploads/ are left untouched.
  $stagingItems = Get-ChildItem -Path $stagingDir
  foreach ($item in $stagingItems) {
    $target       = Join-Path $AppDir   $item.Name
    $backupTarget = Join-Path $backupDir $item.Name
    if (Test-Path $target) {
      Log "Backup: $target -> $backupTarget"
      Move-Item -Path $target -Destination $backupTarget -Force
    }
    Log "Apply: $($item.FullName) -> $target"
    Move-Item -Path $item.FullName -Destination $target -Force
  }

  Remove-Item -Recurse -Force $stagingDir -ErrorAction SilentlyContinue
  $stagingDir = $null

  # Update marker files so the next delta update can compare against this one
  if ($NewLockHash) {
    Set-Content -Path (Join-Path $AppDir ".lock-hash") -Value $NewLockHash -NoNewline -Encoding ASCII
    Log "Wrote .lock-hash: $NewLockHash"
  }
  if ($NewVersion) {
    Set-Content -Path (Join-Path $AppDir ".installed-version") -Value $NewVersion -NoNewline -Encoding ASCII
    Log "Wrote .installed-version: $NewVersion"
  }

  # Start service
  Log "Starting service..."
  if (Test-Path $nssm) {
    & $nssm start $ServiceName 2>&1 | Out-Null
  } else {
    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 4

  # Verify the service actually came up
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc -or $svc.Status -ne 'Running') {
    throw "Service did not start after update (status: $($svc.Status))"
  }
  Log "Service running. Backup retained at $backupDir"
  Log "=== Update complete ==="

  # Clean up the dropped zip
  try { Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue } catch {}

  exit 0
} catch {
  Log "ERROR: $_"
  if ($backupDir -and (Test-Path $backupDir)) {
    Log "Rolling back from $backupDir..."
    try {
      Get-ChildItem -Path $backupDir | ForEach-Object {
        $target = Join-Path $AppDir $_.Name
        if (Test-Path $target) { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
        Move-Item -Path $_.FullName -Destination $target -Force
      }
      Log "Rollback complete."
    } catch {
      Log "Rollback ALSO failed: $_  Backup files left at $backupDir for manual recovery."
    }
  }
  if ($stagingDir -and (Test-Path $stagingDir)) {
    Remove-Item -Recurse -Force $stagingDir -ErrorAction SilentlyContinue
  }

  # Best-effort restart
  Log "Attempting to restart service..."
  try {
    if (Test-Path (Join-Path $AppDir "nssm\nssm.exe")) {
      & (Join-Path $AppDir "nssm\nssm.exe") start $ServiceName 2>&1 | Out-Null
    } else {
      Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
    }
  } catch {}

  exit 1
}
